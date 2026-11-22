import test from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackAddress, isSameOrigin, rejectReason } from '../src/ui.js'

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
