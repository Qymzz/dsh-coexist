import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { scanBundleSources, detectSourceConflicts } from '../src/sourcescan.js'

async function makeBundle(name, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coexist-source-'))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  await fs.mkdir(path.join(dir, 'lib'), { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, 'lib', file), content)
  }
  return { name, dir }
}

const SOURCE = `
export function apply(ctx) {
  ctx.commands.register({ name: 'side', description: 'side chat', handler: () => ({ kind: 'success' }) })
  ctx.llm.registerAdapter(['workbuddy'], adapter)
  ctx.llm.registerConfigurableProviders([{ provider: 'workbuddy-pro', displayName: 'x', settingsNs: 'x', settingsPath: [] }])
  ctx.slots.register({ name: 'recent-sessions', id: 'main' }, component)
  const lockFile = 'coexist-demo.lock'
}
`

test('scanBundleSources finds command/provider/slot/lock resources', async () => {
  const a = await makeBundle('plugin-a', { 'a.js': SOURCE })
  const b = await makeBundle('plugin-b', { 'b.js': SOURCE })
  const resources = await scanBundleSources([a, b])

  assert.deepEqual([...resources.command.keys()], ['side'])
  assert.deepEqual([...resources.provider.keys()].sort(), ['workbuddy', 'workbuddy-pro'])
  assert.deepEqual([...resources['ui-slot'].keys()], ['recent-sessions#main'])
  assert.deepEqual([...resources['file-lock'].keys()], ['coexist-demo.lock'])
})

test('detectSourceConflicts reports shared resources and ignores single owners', async () => {
  const a = await makeBundle('plugin-a', { 'a.js': SOURCE })
  const b = await makeBundle('plugin-b', { 'b.js': SOURCE })
  const c = await makeBundle('plugin-c', {
    'c.js': "ctx.commands.register({ name: 'unique', description: 'x', handler })",
  })
  const sources = await scanBundleSources([a, b, c])
  const conflicts = detectSourceConflicts(sources)
  const byKey = Object.fromEntries(conflicts.map((item) => [item.resource.key, item]))

  assert.equal(byKey.side.severity, 'conflict')
  assert.equal(byKey.side.recommended, 'runtime-alias')
  assert.deepEqual(byKey.side.owners.sort(), ['plugin-a', 'plugin-b'])

  assert.equal(byKey.workbuddy.severity, 'conflict')
  assert.equal(byKey['recent-sessions#main'].severity, 'info')
  assert.equal(byKey['coexist-demo.lock'].severity, 'info')

  assert.equal(byKey.unique, undefined)
})

test('scanBundleSources skips node_modules and non-source files', async () => {
  const a = await makeBundle('plugin-a', { 'a.js': SOURCE })
  await fs.mkdir(path.join(a.dir, 'node_modules', 'x'), { recursive: true })
  await fs.writeFile(
    path.join(a.dir, 'node_modules', 'x', 'index.js'),
    "ctx.commands.register({ name: 'hidden', description: 'x', handler })",
  )
  await fs.writeFile(path.join(a.dir, 'lib', 'notes.txt'), "ctx.commands.register({ name: 'text', description: 'x', handler })")

  const resources = await scanBundleSources([a])
  assert.equal(resources.command.has('hidden'), false)
  assert.equal(resources.command.has('text'), false)
})
