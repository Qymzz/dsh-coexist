import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectionRejection, isLoopbackAddress, isSameOrigin, rejectReason, resolveCli } from '../src/ui.js'

test('isLoopbackAddress accepts loopback and in-process calls', () => {
  assert.equal(isLoopbackAddress(undefined), true)
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.8.9.10'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
})

test('isLoopbackAddress rejects LAN and mapped LAN addresses', () => {
  assert.equal(isLoopbackAddress('192.168.1.5'), false)
  assert.equal(isLoopbackAddress('::ffff:192.168.1.5'), false)
  assert.equal(isLoopbackAddress('10.0.0.2'), false)
})

test('isSameOrigin accepts absent/null Origin and matching hosts', () => {
  assert.equal(isSameOrigin({}), true)
  assert.equal(isSameOrigin({ origin: 'null' }), true)
  assert.equal(isSameOrigin({ origin: 'http://127.0.0.1:56002', host: '127.0.0.1:56002' }), true)
  assert.equal(isSameOrigin({ origin: 'https://127.0.0.1:56002', host: '127.0.0.1:56002' }), true)
  assert.equal(isSameOrigin({ origin: 'dsh-app://app', host: '127.0.0.1:56002' }), true)
})

test('isSameOrigin rejects another site or a malformed Origin', () => {
  assert.equal(isSameOrigin({ origin: 'https://evil.example', host: '127.0.0.1:56002' }), false)
  assert.equal(isSameOrigin({ origin: 'not a url', host: '127.0.0.1:56002' }), false)
})

test('rejectReason accepts a local same-origin JSON POST', () => {
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:56002', origin: 'http://127.0.0.1:56002', 'content-type': 'application/json; charset=utf-8' },
  }
  assert.equal(rejectReason(req), null)
})

test('rejectReason blocks wrong method, non-JSON body, cross-site origin and LAN peers', () => {
  const base = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:56002', 'content-type': 'application/json' },
  }
  assert.equal(rejectReason({ ...base, method: 'GET' }), 'POST required')
  assert.equal(rejectReason({ ...base, headers: { ...base.headers, 'content-type': 'text/plain' } }), 'application/json required')
  assert.equal(
    rejectReason({ ...base, headers: { ...base.headers, origin: 'https://evil.example' } }),
    'cross-origin request rejected',
  )
  assert.equal(rejectReason({ ...base, socket: { remoteAddress: '192.168.1.5' } }), 'local requests only')
})

test('connectionRejection forwards 401/403 from the DSH connection service', () => {
  const req = { headers: { host: '127.0.0.1:56002' } }
  const makeCtx = (rejection) => ({
    get: (name) => (name === 'connection' ? { requestRejection: () => rejection } : undefined),
  })
  assert.equal(connectionRejection(makeCtx(401), req), 401)
  assert.equal(connectionRejection(makeCtx(403), req), 403)
  assert.equal(connectionRejection(makeCtx(undefined), req), undefined)
})

test('connectionRejection falls back when the connection service is absent', () => {
  const req = { headers: {} }
  assert.equal(connectionRejection({}, req), undefined)
  assert.equal(connectionRejection({ get: () => undefined }, req), undefined)
  assert.equal(connectionRejection({ connection: {} }, req), undefined)
})

test('connectionRejection reads ctx.connection directly and fails closed on errors', () => {
  const req = { headers: {} }
  assert.equal(connectionRejection({ connection: { requestRejection: () => 401 } }, req), 401)

  const logs = []
  const ctx = {
    connection: {
      requestRejection: () => {
        throw new Error('boom')
      },
    },
  }
  assert.equal(connectionRejection(ctx, req, (line) => logs.push(line)), 403)
  assert.match(logs[0], /connection check failed: boom/)
})

test('resolveCli accepts a JS entry and rejects cmd/bat paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coexist-cli-'))
  try {
    const js = path.join(dir, 'cli.js')
    fs.writeFileSync(js, '')
    const resolved = resolveCli({ cliPath: js })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.file, process.execPath)
    assert.deepEqual(resolved.prefix, [js])

    for (const name of ['cli.cmd', 'cli.bat']) {
      const file = path.join(dir, name)
      fs.writeFileSync(file, '')
      const rejected = resolveCli({ cliPath: file })
      assert.equal(rejected.ok, false)
      assert.match(rejected.error, /Unsupported CLI path/)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
