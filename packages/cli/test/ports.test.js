import test from 'node:test'
import assert from 'node:assert/strict'
import { freePort, parseNetstat, parseTasklistCsv } from '../src/ports.js'

const SAMPLE = `
  TCP    127.0.0.1:4100         0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:4100         127.0.0.1:55000        ESTABLISHED     1234
  TCP    [::]:4100              [::]:0                 LISTENING       5678
  TCP    127.0.0.1:4200         0.0.0.0:0              LISTENING       9999
`

const TASKLIST = `
"node.exe","1234","Console","1","12,345 K"
"other.exe","5678","Console","1","12,345 K"
`

test('parseNetstat only returns LISTENING pids for the exact port', () => {
  assert.deepEqual(parseNetstat(SAMPLE, 4100).sort(), [1234, 5678])
  assert.deepEqual(parseNetstat(SAMPLE, 4200), [9999])
  assert.deepEqual(parseNetstat(SAMPLE, 4300), [])
})

test('parseTasklistCsv maps pids to process names', () => {
  const owners = parseTasklistCsv(TASKLIST)
  assert.equal(owners.get(1234), 'node.exe')
  assert.equal(owners.get(5678), 'other.exe')
})

test('freePort is read-only without --yes', async () => {
  const calls = []
  const runCommand = async (file, args) => {
    calls.push([file, ...args])
    if (file === 'netstat') return { stdout: SAMPLE }
    if (file === 'tasklist') return { stdout: TASKLIST }
    return { stdout: '' }
  }

  const result = await freePort(4100, { runCommand })
  if (process.platform === 'win32') {
    assert.equal(result.ok, true)
    assert.deepEqual(result.pids.sort(), [1234, 5678])
    assert.deepEqual(result.owners.sort((a, b) => a.pid - b.pid), [
      { pid: 1234, name: 'node.exe' },
      { pid: 5678, name: 'other.exe' },
    ])
  } else {
    assert.equal(result.ok, false)
  }
  assert.deepEqual(result.killed, [])
  assert.equal(calls.some(([file]) => file === 'taskkill'), false)
})

test('freePort only kills allowed processes unless --force', async () => {
  const killed = []
  const runCommand = async (file, args) => {
    if (file === 'netstat') return { stdout: SAMPLE }
    if (file === 'tasklist') return { stdout: TASKLIST }
    killed.push(args)
    return { stdout: '' }
  }

  const result = await freePort(4100, { runCommand, yes: true })
  if (process.platform !== 'win32') {
    assert.equal(result.ok, false)
    return
  }
  assert.deepEqual(result.killed, [1234])
  assert.deepEqual(result.skipped, [{ pid: 5678, name: 'other.exe', reason: 'not a DSH process' }])
  assert.equal(killed.length, 1)
})

test('freePort --force kills non-DSH processes too', async () => {
  const killed = []
  const runCommand = async (file, args) => {
    if (file === 'netstat') return { stdout: SAMPLE }
    if (file === 'tasklist') return { stdout: TASKLIST }
    killed.push(args)
    return { stdout: '' }
  }

  const result = await freePort(4100, { runCommand, yes: true, force: true })
  if (process.platform !== 'win32') {
    assert.equal(result.ok, false)
    return
  }
  assert.deepEqual(result.killed.sort(), [1234, 5678])
  assert.deepEqual(result.skipped, [])
  assert.equal(killed.length, 2)
})
