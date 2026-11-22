import test from 'node:test'
import assert from 'node:assert/strict'
import { installProviderPatch } from '../src/providers.js'

function reset() {
  delete globalThis.__dshCoexistProviderPatched
  globalThis.__dshCoexistActive = true
}

function makeLlm() {
  return class FakeLlm {
    constructor() {
      this.adapters = new Map()
      this.directory = new Map()
    }

    registerAdapter(providers, adapter) {
      const owned = []
      for (const provider of providers) {
        if (this.adapters.has(provider) || owned.includes(provider)) {
          const error = new Error(`an adapter for provider "${provider}" is already registered`)
          error.code = 'DUPLICATE_ADAPTER'
          throw error
        }
        const info = adapter.providerInfo(provider)
        if (info.id !== provider) {
          const error = new Error(`adapter metadata for provider "${provider}" must preserve its id`)
          error.code = 'INVALID_ADAPTER'
          throw error
        }
        owned.push(provider)
      }
      for (const provider of owned) this.adapters.set(provider, { adapter })
      return () => {
        for (const provider of owned) this.adapters.delete(provider)
      }
    }

    registerConfigurableProviders(entries) {
      for (const entry of entries) {
        if (this.directory.has(entry.provider)) {
          const error = new Error(`configurable provider "${entry.provider}" is already declared`)
          error.code = 'DUPLICATE_DIRECTORY'
          throw error
        }
      }
      for (const entry of entries) this.directory.set(entry.provider, entry)
      return () => {
        for (const entry of entries) this.directory.delete(entry.provider)
      }
    }
  }
}

function adapterFor(label) {
  return {
    label,
    providerInfo: (provider) => ({ id: provider, name: label }),
    resolveModel: (provider, model) => ({ provider, model }),
    prepareCall: (provider, model) => ({ provider, model }),
  }
}

test('重复 provider 改成别名，adapter 调用时换回原名', async () => {
  reset()
  const FakeLlm = makeLlm()
  const aliases = []
  installProviderPatch(FakeLlm, {
    log: () => {},
    onAlias: (event) => aliases.push(event),
  })

  const llm = new FakeLlm()
  llm.registerAdapter(['workbuddy'], adapterFor('A'))
  llm.registerAdapter(['workbuddy'], adapterFor('B'))

  assert.equal(llm.adapters.has('workbuddy'), true)
  assert.equal(llm.adapters.has('workbuddy__coexist1'), true)
  assert.deepEqual(aliases, [
    { kind: 'provider', name: 'workbuddy', alias: 'workbuddy__coexist1' },
  ])

  const entry = llm.adapters.get('workbuddy__coexist1')
  assert.deepEqual(entry.adapter.providerInfo('workbuddy__coexist1'), {
    id: 'workbuddy__coexist1',
    name: 'B',
  })
  assert.deepEqual(entry.adapter.resolveModel('workbuddy__coexist1', 'm'), {
    provider: 'workbuddy',
    model: 'm',
  })
})

test('多个 provider 只给冲突的那个加别名', () => {
  reset()
  const FakeLlm = makeLlm()
  installProviderPatch(FakeLlm, { log: () => {} })

  const llm = new FakeLlm()
  llm.registerAdapter(['x'], adapterFor('A'))
  llm.registerAdapter(['x', 'y'], adapterFor('B'))

  assert.equal(llm.adapters.has('x__coexist1'), true)
  assert.equal(llm.adapters.has('y'), true)
})

test('provider N 路别名', () => {
  reset()
  const FakeLlm = makeLlm()
  installProviderPatch(FakeLlm, { log: () => {} })

  const llm = new FakeLlm()
  llm.registerAdapter(['x'], adapterFor('A'))
  llm.registerAdapter(['x'], adapterFor('B'))
  llm.registerAdapter(['x'], adapterFor('C'))

  assert.equal(llm.adapters.has('x__coexist1'), true)
  assert.equal(llm.adapters.has('x__coexist2'), true)
})

test('provider 别名的 disposer 只移除别名', () => {
  reset()
  const FakeLlm = makeLlm()
  installProviderPatch(FakeLlm, { log: () => {} })

  const llm = new FakeLlm()
  const disposeA = llm.registerAdapter(['x'], adapterFor('A'))
  const disposeB = llm.registerAdapter(['x'], adapterFor('B'))

  disposeB()
  assert.equal(llm.adapters.has('x__coexist1'), false)
  assert.equal(llm.adapters.has('x'), true)
  disposeA()
  assert.equal(llm.adapters.size, 0)
})

test('非重复 provider 错误原样上抛', () => {
  reset()
  const FakeLlm = makeLlm()
  installProviderPatch(FakeLlm, { log: () => {} })

  const llm = new FakeLlm()
  const broken = {
    providerInfo: () => ({ id: 'wrong', name: 'broken' }),
  }
  assert.throws(() => llm.registerAdapter(['x'], broken), /must preserve its id/)
})

test('coexist 未激活时保留原生 provider 重复行为', () => {
  reset()
  const FakeLlm = makeLlm()
  installProviderPatch(FakeLlm, { log: () => {} })
  globalThis.__dshCoexistActive = false

  const llm = new FakeLlm()
  llm.registerAdapter(['x'], adapterFor('A'))
  assert.throws(() => llm.registerAdapter(['x'], adapterFor('B')), /already registered/)
})

test('configurable provider 重复时改成别名', () => {
  reset()
  const FakeLlm = makeLlm()
  installProviderPatch(FakeLlm, { log: () => {} })

  const llm = new FakeLlm()
  llm.registerConfigurableProviders([
    { provider: 'workbuddy', displayName: 'A', settingsNs: 'workbuddy', settingsPath: [] },
  ])
  llm.registerConfigurableProviders([
    { provider: 'workbuddy', displayName: 'B', settingsNs: 'workbuddy', settingsPath: [] },
  ])

  assert.equal(llm.directory.has('workbuddy'), true)
  assert.equal(llm.directory.has('workbuddy__coexist1'), true)
  assert.equal(llm.directory.get('workbuddy__coexist1').displayName, 'B')
})
