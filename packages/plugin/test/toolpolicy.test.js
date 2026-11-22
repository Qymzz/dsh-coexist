import test from 'node:test'
import assert from 'node:assert/strict'
import { installToolObservation, installToolPolicies } from '../src/toolpolicy.js'

function reset() {
  const disposePolicy = globalThis.__dshCoexistToolPolicyDispose
  if (typeof disposePolicy === 'function') disposePolicy()
  delete globalThis.__dshCoexistToolPolicyDispose
  const disposeObservation = globalThis.__dshCoexistToolObservationDispose
  if (typeof disposeObservation === 'function') disposeObservation()
  delete globalThis.__dshCoexistToolObservationDispose
}

function makeToolService() {
  return {
    guardFn: null,
    guard(fn) {
      this.guardFn = fn
      return () => {
        this.guardFn = null
      }
    },
  }
}

test('tool policies deny by name and pass through unmatched tools', () => {
  reset()
  const service = makeToolService()
  const result = installToolPolicies(service, {
    policies: { memory_search: { deny: true, reason: 'disabled for test' } },
  })

  assert.equal(result.installed, true)
  assert.equal(service.guardFn({ name: 'memory_search' }), 'disabled for test')
  assert.equal(service.guardFn({ name: 'read' }), undefined)
})

test('tool policies support allow/deny agent lists and wildcard rules', () => {
  reset()
  const service = makeToolService()
  installToolPolicies(service, {
    policies: {
      '*': { denyAgents: ['bad-agent'] },
      memory_search: { allowAgents: ['agent-x'] },
    },
  })

  assert.match(service.guardFn({ name: 'read', agent: { name: 'bad-agent' } }), /denied/)
  assert.equal(service.guardFn({ name: 'read', agent: { name: 'good-agent' } }), undefined)
  assert.equal(
    service.guardFn({ name: 'memory_search', agent: { name: 'agent-x' } }),
    undefined,
  )
  assert.match(service.guardFn({ name: 'memory_search', agent: { name: 'agent-y' } }), /not allowed/)
})

test('empty tool policy config installs nothing', () => {
  reset()
  const service = makeToolService()
  assert.equal(installToolPolicies(service, { policies: {} }).installed, false)
})

test('tool observation records calls and returns the original decision', async () => {
  reset()
  const calls = []
  let listener
  const ctx = {
    on: (event, fn) => {
      assert.equal(event, 'tools/post-execute')
      listener = fn
      return () => {
        listener = null
      }
    },
  }

  const result = installToolObservation(ctx, {
    onCall: (event) => calls.push(event),
  })
  assert.equal(result.installed, true)

  const decision = await listener(
    { name: 'memory_search', agent: { name: 'agent-x' } },
    { isError: false },
    async () => ({ kind: 'accept' }),
  )

  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'memory_search')
  assert.equal(calls[0].agent, 'agent-x')
  assert.equal(calls[0].blocked, false)
})

test('tool observation records errors and rethrows', async () => {
  reset()
  const calls = []
  let listener
  const ctx = {
    on: (_event, fn) => {
      listener = fn
      return () => {}
    },
  }
  installToolObservation(ctx, { onCall: (event) => calls.push(event) })

  await assert.rejects(
    listener({ name: 'memory_search' }, { isError: false }, async () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(calls.at(-1).error, 'boom')
})
