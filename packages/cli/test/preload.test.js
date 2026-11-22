import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installPrototypePatch } from '../src/preload/patch.js'
import { loadConfig, normalizeWatch, parseRunArgs } from '../src/launcher.js'

function makeFakeTools() {
  const stores = new Map()

  return class FakeToolsService {
    constructor(scope = 'global') {
      this.ctx = { scope }
      if (!stores.has(scope)) stores.set(scope, new Map())
      this.store = stores.get(scope)
    }

    register(definition) {
      if (this.store.has(definition.name)) {
        throw new Error(`duplicate tool: ${definition.name}`)
      }
      this.store.set(definition.name, definition)
      return () => this.store.delete(definition.name)
    }
  }
}

function scopeOf(ctx) {
  return ctx.scope
}

function resetPatchFlag() {
  delete globalThis.__dshCoexistPrototypePatched
}

test('auto mode aliases a duplicate tool in the same scope', () => {
  resetPatchFlag()
  const FakeToolsService = makeFakeTools()
  installPrototypePatch(FakeToolsService, { auto: true, scopeOf, log: () => {} })

  const first = new FakeToolsService('global')
  const second = new FakeToolsService('global')
  first.register({ name: 'memory_search', description: 'A', execute: async () => 'A' })
  second.register({ name: 'memory_search', description: 'B', execute: async () => 'B' })

  assert.deepEqual(
    [...first.store.keys()].sort(),
    ['memory_search', 'memory_search__coexist1'],
  )
})

test('auto mode leaves different scopes alone', () => {
  resetPatchFlag()
  const FakeToolsService = makeFakeTools()
  installPrototypePatch(FakeToolsService, { auto: true, scopeOf, log: () => {} })

  const agentOne = new FakeToolsService('agent-1')
  const agentTwo = new FakeToolsService('agent-2')
  agentOne.register({ name: 'memory_search', description: 'A', execute: async () => 'A' })
  agentTwo.register({ name: 'memory_search', description: 'B', execute: async () => 'B' })

  assert.deepEqual([...agentOne.store.keys()], ['memory_search'])
  assert.deepEqual([...agentTwo.store.keys()], ['memory_search'])
})

test('auto mode ignores an identical duplicate definition', () => {
  resetPatchFlag()
  const FakeToolsService = makeFakeTools()
  installPrototypePatch(FakeToolsService, { auto: true, scopeOf, log: () => {} })

  const tools = new FakeToolsService('global')
  const definition = { name: 'memory_search', description: 'A', execute: async () => 'A' }
  tools.register(definition)
  tools.register(definition)

  assert.deepEqual([...tools.store.keys()], ['memory_search'])
})

test('watch mode only aliases the watched names', () => {
  resetPatchFlag()
  const FakeToolsService = makeFakeTools()
  installPrototypePatch(FakeToolsService, {
    watch: ['memory_search'],
    scopeOf,
    log: () => {},
  })

  const first = new FakeToolsService('global')
  const second = new FakeToolsService('global')
  first.register({ name: 'memory_search', description: 'A', execute: async () => 'A' })
  second.register({ name: 'memory_search', description: 'B', execute: async () => 'B' })

  assert.deepEqual(
    [...first.store.keys()].sort(),
    ['memory_search', 'memory_search__coexist1'],
  )

  first.register({ name: 'other_tool', description: 'A', execute: async () => 'A' })
  assert.throws(
    () => second.register({ name: 'other_tool', description: 'B', execute: async () => 'B' }),
    /duplicate tool/,
  )
})

test('parseRunArgs splits launcher options from DSH arguments', () => {
  const options = parseRunArgs([
    '--watch',
    'memory_search',
    '--dsh-bin',
    'dsh.js',
    '--',
    '--profile',
    'web',
    '--port',
    '3100',
  ])

  assert.equal(options.watch, 'memory_search')
  assert.equal(options.dshBin, 'dsh.js')
  assert.deepEqual(options.dshArgs, ['--profile', 'web', '--port', '3100'])
})

test('normalizeWatch trims comma-separated names', () => {
  assert.deepEqual(normalizeWatch('memory_search, other_tool '), ['memory_search', 'other_tool'])
  assert.deepEqual(normalizeWatch([' a ', 'b']), ['a', 'b'])
  assert.deepEqual(normalizeWatch(undefined), [])
})

test('loadConfig reads the default coexist config', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-coexist-config-'))
  try {
    await fs.mkdir(path.join(home, 'coexist'), { recursive: true })
    await fs.writeFile(
      path.join(home, 'coexist', 'config.json'),
      `${JSON.stringify({ watch: ['memory_search'] })}\n`,
    )

    const { file, config } = await loadConfig(home)
    assert.equal(file, path.join(home, 'coexist', 'config.json'))
    assert.deepEqual(config.watch, ['memory_search'])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
