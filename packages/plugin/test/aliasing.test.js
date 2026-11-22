import test from 'node:test'
import assert from 'node:assert/strict'
import { installToolAliasing } from '../src/aliasing.js'

function makeTool(name, result) {
  return {
    name,
    description: `tool ${name}`,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return result
    },
  }
}

function makeCtx() {
  const store = new Map()
  const tools = {}
  tools.register = (def) => {
    if (store.has(def.name)) throw new Error(`duplicate tool name: ${def.name}`)
    store.set(def.name, def)
    return () => store.delete(def.name)
  }

  const effects = []
  const logs = []

  return {
    tools,
    store,
    effects,
    logs,
    effect(fn) {
      effects.push(fn)
    },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    dispose() {
      for (const fn of effects.reverse()) {
        const disposer = fn()
        if (typeof disposer === 'function') disposer()
      }
    },
  }
}

test('aliases a duplicate tool name and keeps both implementations callable', async () => {
  const ctx = makeCtx()
  const handle = installToolAliasing(ctx, { watch: ['*'] })
  assert.equal(handle.installed, true)

  ctx.tools.register(makeTool('memory_search', 'A'))
  ctx.tools.register(makeTool('memory_search', 'B'))

  assert.deepEqual([...ctx.store.keys()].sort(), ['memory_search', 'memory_search__coexist1'])
  assert.equal(await ctx.store.get('memory_search').execute(), 'A')
  assert.equal(await ctx.store.get('memory_search__coexist1').execute(), 'B')
})

test('empty watch list disables coexistence', () => {
  const ctx = makeCtx()
  const original = ctx.tools.register
  const handle = installToolAliasing(ctx, {})

  assert.equal(handle.installed, false)
  assert.match(handle.reason, /watch list is empty/)
  assert.equal(ctx.tools.register, original)
})

test('disposing the alias removes only that implementation', async () => {
  const ctx = makeCtx()
  installToolAliasing(ctx, { watch: ['*'] })

  ctx.tools.register(makeTool('memory_search', 'A'))
  const disposeB = ctx.tools.register(makeTool('memory_search', 'B'))

  assert.equal(ctx.store.size, 2)
  disposeB()
  assert.deepEqual([...ctx.store.keys()], ['memory_search'])
})

test('disposing the primary keeps the surviving alias', () => {
  const ctx = makeCtx()
  installToolAliasing(ctx, { watch: ['*'] })

  const disposeA = ctx.tools.register(makeTool('memory_search', 'A'))
  ctx.tools.register(makeTool('memory_search', 'B'))

  disposeA()
  assert.deepEqual([...ctx.store.keys()], ['memory_search__coexist1'])
})

test('reserved run_code keeps native behavior', () => {
  const ctx = makeCtx()
  installToolAliasing(ctx, { watch: ['*'] })

  ctx.tools.register(makeTool('run_code', 'A'))
  assert.throws(() => ctx.tools.register(makeTool('run_code', 'B')), /duplicate tool name/)
})

test('non-writable tools returns installed=false without throwing', () => {
  const ctx = makeCtx()
  Object.freeze(ctx.tools)

  const handle = installToolAliasing(ctx, { watch: ['*'] })
  assert.equal(handle.installed, false)
  assert.match(handle.reason, /not writable/)
})

test('effect cleanup restores the original register method', () => {
  const ctx = makeCtx()
  const handle = installToolAliasing(ctx, { watch: ['*'] })
  assert.notEqual(ctx.tools.register, handle.originalRegister)

  ctx.dispose()
  assert.equal(ctx.tools.register, handle.originalRegister)
})

test('alias names stay within the 64 character tool-name limit', async () => {
  const ctx = makeCtx()
  installToolAliasing(ctx, { watch: ['*'] })

  const longName = 'memory_search_' + 'x'.repeat(60)
  ctx.tools.register(makeTool(longName, 'A'))
  ctx.tools.register(makeTool(longName, 'B'))

  const alias = [...ctx.store.keys()].find((name) => name !== longName)
  assert.ok(alias)
  assert.ok(alias.length <= 64, `alias length ${alias.length}`)
  assert.equal(await ctx.store.get(alias).execute(), 'B')
})
