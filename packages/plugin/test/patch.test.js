import test from 'node:test'
import assert from 'node:assert/strict'
import { installPrototypePatch } from '../src/patch.js'

function makeService() {
  return class FakeTools {
    constructor() {
      this.registry = new Map()
      this.layers = { global: { tools: { get: (name) => this.registry.get(name) } } }
    }

    register(definition) {
      if (definition.name === 'run_code') {
        throw new Error('tool name "run_code" is reserved for the PTC mode presentation transport')
      }
      if (this.registry.has(definition.name)) {
        throw new Error(
          `tool "${definition.name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`,
        )
      }
      this.registry.set(definition.name, definition)
      return () => this.registry.delete(definition.name)
    }
  }
}

function define(name, result) {
  return { name, description: name, async execute() { return result } }
}

function reset() {
  delete globalThis.__dshCoexistPrototypePatched
  delete globalThis.__dshCoexistActive
}

test('重名注册改成别名，两个实现都保留', async () => {
  reset()
  const FakeTools = makeService()
  installPrototypePatch(FakeTools, { auto: true, log: () => {} })

  const tools = new FakeTools()
  tools.register(define('memory_search', 'A'))
  tools.register(define('memory_search', 'B'))

  assert.deepEqual([...tools.registry.keys()], ['memory_search', 'memory_search__coexist1'])
  assert.equal(await tools.registry.get('memory_search').execute(), 'A')
  assert.equal(await tools.registry.get('memory_search__coexist1').execute(), 'B')
})

test('非重名工具保持原名', () => {
  reset()
  const FakeTools = makeService()
  installPrototypePatch(FakeTools, { auto: true, log: () => {} })

  const tools = new FakeTools()
  tools.register(define('read', 'A'))
  tools.register(define('write', 'B'))

  assert.deepEqual([...tools.registry.keys()], ['read', 'write'])
})

test('非重名错误原样上抛', () => {
  reset()
  class Boom {
    register() {
      throw new TypeError('bad definition')
    }
  }
  installPrototypePatch(Boom, { auto: true, log: () => {} })

  assert.throws(() => new Boom().register(), /bad definition/)
})

test('run_code 保留原生报错，不改成别名', () => {
  reset()
  const FakeTools = makeService()
  installPrototypePatch(FakeTools, { auto: true, log: () => {} })

  const tools = new FakeTools()
  assert.throws(() => tools.register(define('run_code', 'A')), /reserved/)
  assert.deepEqual([...tools.registry.keys()], [])
})

test('watch 模式只接管列出的工具名', () => {
  reset()
  const FakeTools = makeService()
  installPrototypePatch(FakeTools, { watch: ['memory_search'], log: () => {} })

  const tools = new FakeTools()
  tools.register(define('memory_search', 'A'))
  tools.register(define('memory_search', 'B'))
  tools.register(define('read', 'A'))

  assert.deepEqual(
    [...tools.registry.keys()],
    ['memory_search', 'memory_search__coexist1', 'read'],
  )
  assert.throws(() => tools.register(define('read', 'B')), /already registered/)
})

test('别名长度不超过 64', () => {
  reset()
  const FakeTools = makeService()
  installPrototypePatch(FakeTools, { auto: true, log: () => {} })

  const tools = new FakeTools()
  const longName = 'a'.repeat(64)
  tools.register(define(longName, 'A'))
  tools.register(define(longName, 'B'))

  const alias = [...tools.registry.keys()][1]
  assert.equal(alias.length, 64)
  assert.ok(alias.endsWith('__coexist1'))
})

test('相同定义重复注册直接忽略，不再制造别名', () => {
  reset()
  const FakeTools = makeService()
  const logs = []
  installPrototypePatch(FakeTools, { auto: true, log: (message) => logs.push(message) })

  const tools = new FakeTools()
  const definition = define('read', 'A')
  tools.register(definition)
  tools.register(definition)

  assert.deepEqual([...tools.registry.keys()], ['read'])
  assert.ok(logs.some((line) => line.includes('identical duplicate ignored')))
})

test('别名被调用时记录调用标记', async () => {
  reset()
  const FakeTools = makeService()
  const calls = []
  installPrototypePatch(FakeTools, {
    auto: true,
    log: () => {},
    onCall: (event) => calls.push(event),
  })

  const tools = new FakeTools()
  tools.register(define('memory_search', 'A'))
  tools.register(define('memory_search', 'B'))

  assert.equal(await tools.registry.get('memory_search__coexist1').execute(), 'B')
  assert.equal(await tools.registry.get('memory_search__coexist1').execute(), 'B')
  assert.deepEqual(calls, [
    { tool: 'memory_search__coexist1', aliasOf: 'memory_search' },
    { tool: 'memory_search__coexist1', aliasOf: 'memory_search' },
  ])
})

test('fallback 模式在主实现失败后降级到备份', async () => {
  reset()
  const FakeTools = makeService()
  const fallbacks = []
  installPrototypePatch(FakeTools, {
    auto: true,
    mode: 'fallback',
    log: () => {},
    onFallback: (event) => fallbacks.push(event),
  })

  const tools = new FakeTools()
  const primary = {
    ...define('memory_search', 'A'),
    async execute() {
      throw new Error('A down')
    },
  }
  tools.register(primary)
  tools.register(define('memory_search', 'B'))

  assert.equal(await tools.registry.get('memory_search').execute(), 'B')
  assert.deepEqual(fallbacks, [{ tool: 'memory_search', error: 'A down', backup: 0 }])
})

test('route 模式按参数选择备份实现', async () => {
  reset()
  const FakeTools = makeService()
  const routes = []
  installPrototypePatch(FakeTools, {
    auto: true,
    mode: 'route',
    routes: { memory_search: { by: 'args', match: { scope: 'code' } } },
    log: () => {},
    onRoute: (event) => routes.push(event),
  })

  const tools = new FakeTools()
  tools.register(define('memory_search', 'A'))
  tools.register(define('memory_search', 'B'))

  assert.equal(await tools.registry.get('memory_search').execute({ scope: 'code' }), 'B')
  assert.equal(await tools.registry.get('memory_search').execute({ scope: 'chat' }), 'A')
  assert.deepEqual(routes, [
    { tool: 'memory_search', target: 'backup', reason: 'args', index: 0 },
  ])
})

test('route 模式按 agent 选择备份实现', async () => {
  reset()
  const FakeTools = makeService()
  installPrototypePatch(FakeTools, {
    auto: true,
    mode: 'route',
    routes: { memory_search: { by: 'agent', equals: 'agent-x' } },
    log: () => {},
  })

  const tools = new FakeTools()
  tools.register(define('memory_search', 'A'))
  tools.register(define('memory_search', 'B'))

  assert.equal(
    await tools.registry.get('memory_search').execute({}, { agent: { name: 'agent-x' } }),
    'B',
  )
  assert.equal(
    await tools.registry.get('memory_search').execute({}, { agent: { name: 'agent-y' } }),
    'A',
  )
})

test('fallback 依次尝试多个备份', async () => {
  reset()
  const FakeTools = makeService()
  const events = []
  installPrototypePatch(FakeTools, {
    auto: true,
    mode: 'fallback',
    log: () => {},
    onFallback: (event) => events.push(event),
  })

  const tools = new FakeTools()
  tools.register({
    ...define('memory_search', 'A'),
    async execute() {
      throw new Error('A down')
    },
  })
  tools.register({
    ...define('memory_search', 'B'),
    async execute() {
      throw new Error('B down')
    },
  })
  tools.register(define('memory_search', 'C'))

  assert.equal(await tools.registry.get('memory_search').execute(), 'C')
  assert.equal(events.length, 1)
  assert.equal(events[0].backup, 1)
})

test('route 可以按 index 选择第 N 个备份', async () => {
  reset()
  const FakeTools = makeService()
  installPrototypePatch(FakeTools, {
    auto: true,
    mode: 'route',
    routes: { memory_search: { by: 'args', match: { scope: 'code' }, index: 1 } },
    log: () => {},
  })

  const tools = new FakeTools()
  tools.register(define('memory_search', 'A'))
  tools.register(define('memory_search', 'B'))
  tools.register(define('memory_search', 'C'))

  assert.equal(await tools.registry.get('memory_search').execute({ scope: 'code' }), 'C')
  assert.equal(await tools.registry.get('memory_search').execute({ scope: 'chat' }), 'A')
})

test('coexist 未激活时保留原生重复行为', () => {
  reset()
  const FakeTools = makeService()
  installPrototypePatch(FakeTools, { auto: true, log: () => {} })
  globalThis.__dshCoexistActive = false

  const tools = new FakeTools()
  tools.register(define('read', 'A'))
  assert.throws(() => tools.register(define('read', 'B')), /already registered/)

  delete globalThis.__dshCoexistActive
})

test('默认 alias 模式不做自动降级', async () => {
  reset()
  const FakeTools = makeService()
  installPrototypePatch(FakeTools, { auto: true, log: () => {} })

  const tools = new FakeTools()
  tools.register({
    ...define('memory_search', 'A'),
    async execute() {
      throw new Error('A down')
    },
  })
  tools.register(define('memory_search', 'B'))

  await assert.rejects(() => tools.registry.get('memory_search').execute(), /A down/)
})
