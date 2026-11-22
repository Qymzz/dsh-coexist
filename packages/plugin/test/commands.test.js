import test from 'node:test'
import assert from 'node:assert/strict'
import { installCommandPatch } from '../src/commands.js'

function reset() {
  delete globalThis.__dshCoexistCommandPatched
  globalThis.__dshCoexistActive = true
}

function makeCommands() {
  return class FakeCommands {
    constructor() {
      this.entries = new Map()
    }

    register(definition) {
      if (!/^[a-z][a-z0-9_-]*$/.test(definition.name)) {
        throw new TypeError(`command name "${definition.name}" must match /^[a-z][a-z0-9_-]*$/`)
      }
      if (this.entries.has(definition.name)) {
        throw new Error(`command "${definition.name}" is already registered`)
      }
      this.entries.set(definition.name, definition)
      return () => this.entries.delete(definition.name)
    }
  }
}

test('同名命令改成别名，两个都能用', () => {
  reset()
  const FakeCommands = makeCommands()
  const aliases = []
  installCommandPatch(FakeCommands, {
    log: () => {},
    onAlias: (event) => aliases.push(event),
  })

  const commands = new FakeCommands()
  commands.register({ name: 'side', description: 'A', handler: () => 'A' })
  commands.register({ name: 'side', description: 'B', handler: () => 'B' })

  assert.equal(commands.entries.get('side').handler(), 'A')
  assert.equal(commands.entries.get('side__coexist1').handler(), 'B')
  assert.equal(commands.entries.get('side__coexist1').name, 'side__coexist1')
  assert.match(commands.entries.get('side__coexist1').description, /coexist alias/)
  assert.deepEqual(aliases, [{ name: 'side', alias: 'side__coexist1', kind: 'command' }])
})

test('多个同名命令依次得到 N 路别名', () => {
  reset()
  const FakeCommands = makeCommands()
  installCommandPatch(FakeCommands, { log: () => {} })

  const commands = new FakeCommands()
  commands.register({ name: 'side', description: 'A', handler: () => 'A' })
  commands.register({ name: 'side', description: 'B', handler: () => 'B' })
  commands.register({ name: 'side', description: 'C', handler: () => 'C' })

  assert.equal(commands.entries.get('side__coexist1').handler(), 'B')
  assert.equal(commands.entries.get('side__coexist2').handler(), 'C')
})

test('别名的 disposer 只移除别名', () => {
  reset()
  const FakeCommands = makeCommands()
  installCommandPatch(FakeCommands, { log: () => {} })

  const commands = new FakeCommands()
  const disposeA = commands.register({ name: 'side', description: 'A', handler: () => 'A' })
  const disposeB = commands.register({ name: 'side', description: 'B', handler: () => 'B' })

  disposeB()
  assert.equal(commands.entries.has('side__coexist1'), false)
  assert.equal(commands.entries.has('side'), true)
  disposeA()
  assert.equal(commands.entries.size, 0)
})

test('非重复错误原样上抛', () => {
  reset()
  const FakeCommands = makeCommands()
  installCommandPatch(FakeCommands, { log: () => {} })

  const commands = new FakeCommands()
  assert.throws(() => commands.register({ name: 'Bad Name', description: 'x', handler: () => {} }), /Bad Name/)
})

test('coexist 未激活时保留原生重复行为', () => {
  reset()
  const FakeCommands = makeCommands()
  installCommandPatch(FakeCommands, { log: () => {} })
  globalThis.__dshCoexistActive = false

  const commands = new FakeCommands()
  commands.register({ name: 'side', description: 'A', handler: () => 'A' })
  assert.throws(
    () => commands.register({ name: 'side', description: 'B', handler: () => 'B' }),
    /already registered/,
  )
})
