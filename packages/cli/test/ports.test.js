import test from 'node:test'
import assert from 'node:assert/strict'
import { freePort, parseNetstat } from '../src/ports.js'

const SAMPLE = `
  TCP    127.0.0.1:4100         0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:4100         127.0.0.1:55000        ESTABLISHED     1234
  TCP    [::]:4100              [::]:0                 LISTENING       5678
  TCP    127.0.0.1:4200         0.0.0.0:0              LISTENING       9999
`

test('parseNetstat only returns LISTENING pids for the exact port', () => {
  assert.deepEqual(parseNetstat(SAMPLE, 4100).sort(), [1234, 5678])
  assert.deepEqual(parseNetstat(SAMPLE, 4200), [9999])
  assert.deepEqual(parseNetstat(SAMPLE, 4300), [])
})

test('freePort is read-only without --yes', async () => {
  const calls = []
  const runCommand = async (file, args) => {
    calls.push([file, ...args])
    if (file === 'netstat') return { stdout: SAMPLE }
    return { stdout: '' }
  }

  const result = await freePort(4100, { runCommand })
  if (process.platform === 'win32') {
    assert.equal(result.ok, true)
    assert.deepEqual(result.pids.sort(), [1234, 5678])
  } else {
    assert.equal(result.ok, false)
  }
  assert.deepEqual(result.killed, [])
  assert.equal(calls.some(([file]) => file === 'taskkill'), false)
})

test('freePort kills listed pids only with --yes', async () => {
  const killed = []
  const runCommand = async (file, args) => {
    if (file === 'netstat') return { stdout: SAMPLE }
    killed.push(args)
    return { stdout: '' }
  }

  const result = await freePort(4100, { runCommand, yes: true })
  if (process.platform === 'win32') {
    assert.deepEqual(result.killed.sort(), [1234, 5678])
    assert.equal(killed.length, 2)
  } else {
    assert.equal(result.ok, false)
  }
})
