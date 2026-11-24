import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  bridgeServiceValues,
  classifyFailure,
  createDiagnostics,
  deriveServiceConflicts,
  installHookPolicy,
  installServiceProbe,
  scanEventHooks,
  scanFibers,
} from '../src/diagnostics.js'
function makeReflect(ctx) {
  return new (class FakeReflect {
    constructor(innerCtx) {
      this.ctx = innerCtx
      this.store = {}
    }

    provide(name, value, check) {
      const label = this.ctx?.[Symbol.for('cordis.isolate')]?.[name]
      const key = label ?? Symbol.for(name)
      if (this.store[key]) {
        throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`)
      }
      this.store[key] = { name, value, fiber: this.ctx.fiber, check }
    }
  })(ctx)
}

function resetProbe() {
  delete globalThis.__dshCoexistServiceProbeInstalled
}

test('service probe records both owners and rethrows', () => {
  resetProbe()
  const reflect = makeReflect({ fiber: { name: 'plugin-a' } })
  const conflicts = []
  installServiceProbe({ reflect }, { onConflict: (conflict) => conflicts.push(conflict) })

  reflect.provide('demo-service', { ok: true })
  reflect.ctx = { fiber: { name: 'plugin-b' } }

  assert.throws(() => reflect.provide('demo-service', { ok: false }), /already been registered|has been registered/)
  assert.deepEqual(conflicts, [
    {
      service: 'demo-service',
      existing: 'plugin-a',
      incoming: 'plugin-b',
      message: 'service "demo-service" has been registered at <plugin-a>',
      resolution: 'blocked',
      suggestion:
        '在 config.json 设置 services["demo-service"].strategy 为 "bridge" 或 "isolate"，或停用其中一个插件',
    },
  ])
})

test('deriveServiceConflicts recovers both owners from a failed fiber', () => {
  assert.deepEqual(
    deriveServiceConflicts([
      {
        plugin: 'plugin-b',
        state: 'failed',
        error: 'service "demoShared" has been registered at <plugin-a>',
      },
      { plugin: 'other', state: 'failed', error: 'boom' },
    ]),
    [
      {
        service: 'demoShared',
        existing: 'plugin-a',
        incoming: 'plugin-b',
        message: 'service "demoShared" has been registered at <plugin-a>',
      },
    ],
  )
})

test('bridgeServiceValues merges disjoint plain objects and rejects overlaps', () => {
  const merged = bridgeServiceValues({ alpha: () => 'A' }, [{ beta: () => 'B' }])
  assert.equal(merged.alpha(), 'A')
  assert.equal(merged.beta(), 'B')

  assert.equal(bridgeServiceValues({ alpha: 1 }, [{ alpha: 2 }]), null)
  assert.equal(bridgeServiceValues('not-an-object', [{ a: 1 }]), null)
  assert.equal(
    bridgeServiceValues({ a: 1 }, [new (class { constructor() { this.b = 2 } })()]),
    null,
  )
})

test('bridgeServiceValues supports explicit overlap first/last', () => {
  const first = bridgeServiceValues({ alpha: () => 'A' }, [{ alpha: () => 'B' }], {
    overlap: 'first',
  })
  assert.equal(first.alpha(), 'A')

  const last = bridgeServiceValues({ alpha: () => 'A' }, [{ alpha: () => 'B' }], {
    overlap: 'last',
  })
  assert.equal(last.alpha(), 'B')
})

test('service probe bridges disjoint services when enabled', () => {
  resetProbe()
  const reflect = makeReflect({ fiber: { name: 'plugin-a' } })
  const conflicts = []
  installServiceProbe(
    { reflect },
    {
      log: () => {},
      serviceBridge: true,
      onConflict: (conflict) => conflicts.push(conflict),
    },
  )

  reflect.provide('demo-service', { alpha: () => 'A' })
  reflect.ctx = { fiber: { name: 'plugin-b' } }
  const dispose = reflect.provide('demo-service', { beta: () => 'B' })

  const impl = reflect.store[Symbol.for('demo-service')]
  assert.equal(impl.value.alpha(), 'A')
  assert.equal(impl.value.beta(), 'B')
  assert.equal(conflicts.at(-1).resolution, 'bridged')

  dispose()
  assert.equal(impl.value.alpha(), 'A')
  assert.equal(impl.value.beta, undefined)
})

test('service probe still rejects overlapping services', () => {
  resetProbe()
  const reflect = makeReflect({ fiber: { name: 'plugin-a' } })
  const conflicts = []
  installServiceProbe(
    { reflect },
    {
      log: () => {},
      serviceBridge: true,
      onConflict: (conflict) => conflicts.push(conflict),
    },
  )

  reflect.provide('demo-service', { alpha: () => 'A' })
  reflect.ctx = { fiber: { name: 'plugin-b' } }

  assert.throws(() => reflect.provide('demo-service', { alpha: () => 'B' }))
  assert.equal(conflicts.at(-1).resolution, 'blocked')
})

test('service probe isolates conflicting services per context when enabled', () => {
  resetProbe()
  const aCtx = { fiber: { name: 'plugin-a' } }
  const bCtx = { fiber: { name: 'plugin-b' } }
  const reflect = makeReflect(aCtx)
  const conflicts = []

  installServiceProbe(
    { reflect },
    {
      log: () => {},
      serviceIsolate: true,
      onConflict: (conflict) => conflicts.push(conflict),
    },
  )

  reflect.provide('demo-service', { alpha: () => 'A' })
  reflect.ctx = bCtx

  assert.doesNotThrow(() => reflect.provide('demo-service', { beta: () => 'B' }))

  const impls = Object.getOwnPropertySymbols(reflect.store).map((symbol) => reflect.store[symbol])
  assert.deepEqual(
    impls.map((impl) => impl.fiber.name).sort(),
    ['plugin-a', 'plugin-b'],
  )
  assert.equal(conflicts.at(-1).resolution, 'isolated')
  assert.ok(bCtx[Symbol.for('cordis.isolate')]?.['demo-service'])
})

test('per-service isolate policy works without the global switch', () => {
  resetProbe()
  const aCtx = { fiber: { name: 'plugin-a' } }
  const bCtx = { fiber: { name: 'plugin-b' } }
  const reflect = makeReflect(aCtx)
  const conflicts = []

  installServiceProbe(
    { reflect },
    {
      log: () => {},
      serviceIsolate: false,
      servicePolicies: { 'demo-service': 'isolate' },
      onConflict: (conflict) => conflicts.push(conflict),
    },
  )

  reflect.provide('demo-service', { alpha: () => 'A' })
  reflect.ctx = bCtx
  assert.doesNotThrow(() => reflect.provide('demo-service', { beta: () => 'B' }))
  assert.equal(conflicts.at(-1).resolution, 'isolated')
})

test('per-service block policy wins over the global bridge switch', () => {
  resetProbe()
  const reflect = makeReflect({ fiber: { name: 'plugin-a' } })
  const conflicts = []

  installServiceProbe(
    { reflect },
    {
      log: () => {},
      serviceBridge: true,
      servicePolicies: { 'demo-service': 'block' },
      onConflict: (conflict) => conflicts.push(conflict),
    },
  )

  reflect.provide('demo-service', { alpha: () => 'A' })
  reflect.ctx = { fiber: { name: 'plugin-b' } }
  assert.throws(() => reflect.provide('demo-service', { beta: () => 'B' }))
  assert.equal(conflicts.at(-1).resolution, 'blocked')
  assert.match(conflicts.at(-1).suggestion, /services\["demo-service"\]/)
})

test('hook policy reorders and disables listeners for configured events', () => {
  delete globalThis.__dshCoexistHookPolicyInstalled

  const EventsClass = class FakeEvents {
    constructor() {
      this._hooks = {}
    }

    dispatch(_type, args) {
      const name = typeof args[0] === 'object' ? args[1] : args[0]
      return (this._hooks[name] ?? []).map((hook) => hook.ctx.fiber.name)
    }
  }

  const events = new EventsClass()
  events._hooks['demo/event'] = [
    { ctx: { fiber: { name: 'plugin-a' } } },
    { ctx: { fiber: { name: 'plugin-b' } } },
    { ctx: { fiber: { name: 'plugin-c' } } },
  ]
  events._hooks['other/event'] = [{ ctx: { fiber: { name: 'plugin-x' } } }]

  const installed = installHookPolicy(
    { events },
    {
      log: () => {},
      hooks: { 'demo/event': { order: ['plugin-c', 'plugin-a'], disable: ['plugin-b'] } },
    },
  )
  assert.equal(installed, true)

  assert.deepEqual(events.dispatch('emit', ['demo/event']), ['plugin-c', 'plugin-a'])
  assert.deepEqual(
    events._hooks['demo/event'].map((hook) => hook.ctx.fiber.name),
    ['plugin-a', 'plugin-b', 'plugin-c'],
  )
  assert.deepEqual(events.dispatch('emit', ['other/event']), ['plugin-x'])
})

test('classifyFailure separates contract, service, dependency, runtime', () => {
  assert.equal(
    classifyFailure('tool "x" must declare output { schema, render }'),
    'contract',
  )
  assert.equal(classifyFailure('service "x" has been registered at <a>'), 'service')
  assert.equal(classifyFailure('Cannot find package "demo"'), 'dependency')
  assert.equal(classifyFailure('boom'), 'runtime')
})

test('service bridge merges N disjoint services', () => {
  resetProbe()
  const reflect = makeReflect({ fiber: { name: 'plugin-a' } })
  const conflicts = []
  installServiceProbe(
    { reflect },
    {
      log: () => {},
      serviceBridge: true,
      onConflict: (conflict) => conflicts.push(conflict),
    },
  )

  reflect.provide('demo-service', { alpha: () => 'A' })
  reflect.ctx = { fiber: { name: 'plugin-b' } }
  reflect.provide('demo-service', { beta: () => 'B' })
  reflect.ctx = { fiber: { name: 'plugin-c' } }
  reflect.provide('demo-service', { gamma: () => 'C' })

  const impl = reflect.store[Symbol.for('demo-service')]
  assert.equal(impl.value.alpha(), 'A')
  assert.equal(impl.value.beta(), 'B')
  assert.equal(impl.value.gamma(), 'C')
  assert.equal(conflicts.filter((item) => item.resolution === 'bridged').length, 2)
})

test('service isolation works for N contexts', () => {
  resetProbe()
  const aCtx = { fiber: { name: 'plugin-a' } }
  const bCtx = { fiber: { name: 'plugin-b' } }
  const cCtx = { fiber: { name: 'plugin-c' } }
  const reflect = makeReflect(aCtx)

  installServiceProbe(
    { reflect },
    { log: () => {}, serviceIsolate: true },
  )

  reflect.provide('demo-service', { alpha: () => 'A' })
  reflect.ctx = bCtx
  reflect.provide('demo-service', { beta: () => 'B' })
  reflect.ctx = cCtx
  reflect.provide('demo-service', { gamma: () => 'C' })

  const impls = Object.getOwnPropertySymbols(reflect.store).map((symbol) => reflect.store[symbol])
  assert.equal(impls.length, 3)
  assert.notEqual(
    bCtx[Symbol.for('cordis.isolate')]?.['demo-service'],
    cCtx[Symbol.for('cordis.isolate')]?.['demo-service'],
  )
})

test('scanFibers reports failed and pending plugins', () => {
  const ctx = {
    registry: {
      values: () => [
        {
          name: 'bad',
          fibers: [
            { uid: 1, state: 3, name: 'bad-plugin', _error: new Error('boom') },
          ],
        },
        {
          name: 'waiting',
          fibers: [
            {
              uid: 2,
              state: 0,
              name: 'waiting-plugin',
              inject: { missingService: null },
              _store: {},
            },
          ],
        },
        { name: 'root', fibers: [{ uid: 0, state: 2, name: 'root' }] },
      ],
    },
  }

  const { failures, pending } = scanFibers(ctx)
  assert.deepEqual(failures, [
    {
      plugin: 'bad-plugin',
      state: 'failed',
      kind: 'runtime',
      error: 'boom',
      suggestion: '查看 report.json 中的完整错误并对照宿主日志',
    },
  ])
  assert.deepEqual(pending, [
    {
      plugin: 'waiting-plugin',
      state: 'pending',
      missing: ['missingService'],
      suggestion: '安装/启用提供 missingService 的 bundle，或给该插件配置 services 策略',
    },
  ])
})

test('scanEventHooks lists public events shared by multiple plugins', () => {
  const ctx = {
    events: {
      _hooks: {
        'demo/event': [
          { ctx: { fiber: { name: 'plugin-a' } } },
          { ctx: { fiber: { name: 'plugin-b' } }, prepend: true },
        ],
        'internal/status': [
          { ctx: { fiber: { name: 'plugin-a' } } },
          { ctx: { fiber: { name: 'plugin-b' } } },
        ],
        'single/event': [{ ctx: { fiber: { name: 'plugin-a' } } }],
      },
    },
  }

  assert.deepEqual(scanEventHooks(ctx), [
    {
      event: 'demo/event',
      owners: ['plugin-a', 'plugin-b'],
      listeners: 2,
      prepend: 1,
      risk: 'medium',
      reason: '存在 prepend 监听器，顺序与注册顺序相反',
      suggestion: 'hooks["demo/event"].order / disable',
    },
  ])
})

test('scanEventHooks marks high-risk mutating events', () => {
  const ctx = {
    events: {
      _hooks: {
        'tools/pre-execute': [
          { ctx: { fiber: { name: 'plugin-a' } } },
          { ctx: { fiber: { name: 'plugin-b' } } },
        ],
      },
    },
  }

  const [hook] = scanEventHooks(ctx)
  assert.equal(hook.risk, 'high')
  assert.match(hook.reason, /门禁/)
})

test('recoverNow retries each failed plugin once when enabled', async () => {
  resetProbe()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coexist-recover-'))
  let restarts = 0
  const ctx = {
    reflect: makeReflect({ fiber: { name: 'coexist' } }),
    on: () => () => {},
    events: { _hooks: {} },
    registry: {
      values: () => [
        {
          fibers: [
            {
              uid: 1,
              state: 3,
              name: 'bad-plugin',
              _error: new Error('boom'),
              restart: () => {
                restarts += 1
              },
            },
          ],
        },
      ],
    },
  }

  const diagnostics = createDiagnostics(ctx, {
    reportFile: path.join(dir, 'report.json'),
    log: () => {},
    delayMs: 600000,
    recover: true,
  })

  try {
    assert.deepEqual(await diagnostics.recoverNow(), ['bad-plugin'])
    assert.deepEqual(await diagnostics.recoverNow(), [])
    assert.equal(restarts, 1)

    diagnostics.write()
    const report = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'))
    assert.equal(report.recoveries.length, 1)
    assert.equal(report.recoveries[0].state, 'restarted')
  } finally {
    diagnostics.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('recoverNow disposes failed service fibers when isolation is on', async () => {
  resetProbe()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coexist-isolate-recover-'))
  const disposed = []
  const ctx = {
    reflect: makeReflect({ fiber: { name: 'coexist' } }),
    on: () => () => {},
    events: { _hooks: {} },
    registry: {
      values: () => [
        {
          fibers: [
            {
              uid: 1,
              state: 3,
              name: 'svc-b',
              _error: new Error('service "demo" has been registered at <svc-a>'),
              dispose: async () => disposed.push('svc-b'),
            },
            {
              uid: 2,
              state: 3,
              name: 'other',
              _error: new Error('boom'),
              dispose: async () => disposed.push('other'),
            },
          ],
        },
      ],
    },
  }

  const diagnostics = createDiagnostics(ctx, {
    reportFile: path.join(dir, 'report.json'),
    log: () => {},
    delayMs: 600000,
    serviceIsolate: true,
  })

  try {
    assert.deepEqual(await diagnostics.recoverNow(), ['svc-b'])
    assert.deepEqual(disposed, ['svc-b'])
    assert.deepEqual(await diagnostics.recoverNow(), [])

    diagnostics.write()
    const report = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'))
    assert.equal(report.recoveries.length, 1)
    assert.equal(report.recoveries[0].state, 'restarted')
  } finally {
    diagnostics.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('diagnostics dispose clears runtime sink and active flag', async () => {
  resetProbe()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coexist-dispose-'))
  const ctx = {
    reflect: makeReflect({ fiber: { name: 'coexist' } }),
    on: () => () => {},
    registry: { values: () => [] },
  }

  const diagnostics = createDiagnostics(ctx, {
    reportFile: path.join(dir, 'report.json'),
    log: () => {},
    delayMs: 600000,
  })

  try {
    assert.equal(globalThis.__dshCoexistActive, true)
    assert.equal(typeof globalThis.__dshCoexistRuntime?.onAlias, 'function')
  } finally {
    diagnostics.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }

  assert.equal(globalThis.__dshCoexistRuntime, undefined)
  assert.equal(globalThis.__dshCoexistActive, false)
})

test('createDiagnostics writes aliases and runtime state to a report file', async () => {
  resetProbe()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coexist-report-'))
  const reportFile = path.join(dir, 'report.json')

  const ctx = {
    reflect: makeReflect({ fiber: { name: 'coexist' } }),
    on: () => () => {},
    registry: {
      values: () => [
        {
          name: 'bad',
          fibers: [
            {
              uid: 1,
              state: 3,
              name: 'bad-plugin',
              _error: new Error(
                'service "demoShared" has been registered at <existing-plugin>',
              ),
            },
          ],
        },
      ],
    },
    events: { _hooks: {} },
  }

  const diagnostics = createDiagnostics(ctx, {
    reportFile,
    log: () => {},
    delayMs: 600000,
    mode: 'fallback',
  })

  try {
    diagnostics.recordAlias('memory_search', 'memory_search__coexist1')
    diagnostics.recordAliasCall({ tool: 'memory_search__coexist1', aliasOf: 'memory_search' })
    diagnostics.recordAliasCall({ tool: 'memory_search__coexist1', aliasOf: 'memory_search' })
    diagnostics.recordFallback({ tool: 'memory_search', error: 'A down' })
    diagnostics.recordRoute({ tool: 'memory_search', target: 'backup', reason: 'args' })
    diagnostics.recordCommandAlias({ name: 'side', alias: 'side__coexist1' })
    diagnostics.recordProviderAlias({ name: 'workbuddy', alias: 'workbuddy__coexist1' })
    diagnostics.recordProviderConflict({
      name: 'blocked-provider',
      message: 'duplicate',
      code: 'DUPLICATE_ADAPTER',
      resolution: 'blocked',
    })
    diagnostics.write()

    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'))
    assert.equal(report.mode, 'fallback')
    assert.deepEqual(report.tools.aliases, [
      { name: 'memory_search', alias: 'memory_search__coexist1', calls: 2 },
    ])
    assert.equal(report.tools.fallbacks.length, 1)
    assert.equal(report.tools.fallbacks[0].tool, 'memory_search')
    assert.equal(report.tools.fallbacks[0].error, 'A down')
    assert.equal(report.tools.routes.length, 1)
    assert.equal(report.tools.routes[0].target, 'backup')
    assert.deepEqual(report.commands.aliases, [{ name: 'side', alias: 'side__coexist1' }])
    assert.deepEqual(report.providers.aliases, [
      { name: 'workbuddy', alias: 'workbuddy__coexist1' },
    ])
    assert.equal(report.providers.conflicts.length, 1)
    assert.equal(report.providers.conflicts[0].resolution, 'blocked')
    assert.deepEqual(report.failures, [
      {
        plugin: 'bad-plugin',
        state: 'failed',
        kind: 'service',
        error: 'service "demoShared" has been registered at <existing-plugin>',
        suggestion: '在 config.json 设置 services 策略（bridge/isolate），或停用 bad-plugin 与其冲突的一方',
      },
    ])
    assert.deepEqual(report.serviceConflicts, [
      {
        service: 'demoShared',
        existing: 'existing-plugin',
        incoming: 'bad-plugin',
        message: 'service "demoShared" has been registered at <existing-plugin>',
      },
    ])
    assert.deepEqual(report.eventHooks, [])
  } finally {
    diagnostics.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('tool stats record p95, per-agent breakdown and slow calls', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coexist-stats-'))
  const reportFile = path.join(dir, 'report.json')
  const ctx = {
    reflect: makeReflect({ fiber: { name: 'coexist' } }),
    on: () => () => {},
    registry: { values: () => [] },
    events: { _hooks: {} },
  }
  const diagnostics = createDiagnostics(ctx, { reportFile, log: () => {}, delayMs: 600000 })
  try {
    for (let index = 1; index <= 20; index += 1) {
      diagnostics.recordToolCall({
        tool: 'memory_search',
        agent: index % 2 === 0 ? 'agent-b' : 'agent-a',
        durationMs: index,
      })
    }
    diagnostics.write()
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'))
    assert.equal(report.tools.stats.memory_search.calls, 20)
    assert.equal(report.tools.stats.memory_search.p95, 19)
    assert.equal(report.tools.stats.memory_search.agents['agent-a'].calls, 10)
    assert.equal(report.tools.stats.memory_search.agents['agent-b'].p95, 20)
    assert.equal(report.tools.slowCalls[0].durationMs, 20)
    assert.equal(report.tools.slowCalls.length, 10)
  } finally {
    diagnostics.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
