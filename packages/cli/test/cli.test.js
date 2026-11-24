import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadGraph } from '../src/graph.js'
import { detectDependencyCycles } from '../src/graph.js'
import { buildPlan } from '../src/plan.js'
import { applyPlan, renameNthLoaderId } from '../src/apply.js'
import { rollback } from '../src/backup.js'
import { runPrefer } from '../src/commands.js'
import { resolveProfile } from '../src/paths.js'

async function makeHome({ conflicts = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-coexist-'))
  const profileDir = path.join(home, 'profiles', 'web')
  await fs.mkdir(profileDir, { recursive: true })

  const bundles = conflicts
    ? ['dsh-bundle-a', 'dsh-bundle-b', 'dsh-bundle-a']
    : ['dsh-bundle-a', 'dsh-bundle-b']

  await fs.writeFile(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'fixture-profile', dsh: { profile: { bundles } } }, null, 2)}\n`,
  )

  const patch = conflicts
    ? `- insert:
    - id: memory-entry
      name: dsh-memory-a
    - id: memory-entry
      name: dsh-memory-b
# keep me
- replace:
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
`
    : `- insert:
    - id: memory-entry
      name: dsh-memory-a
`

  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), patch)
  await fs.writeFile(
    path.join(home, 'cordis.patch.yml'),
    `- insert:
    - id: web-ui-compat
      name: dsh-web-ui
`,
  )

  return { home, profileDir }
}

async function cleanup(home) {
  await fs.rm(home, { recursive: true, force: true })
}

test('detects duplicate loader ids and duplicate bundles', async () => {
  const { home, profileDir } = await makeHome()
  try {
    const graph = await loadGraph({ home, profile: 'web', dir: profileDir })
    const found = graph.conflicts.map((conflict) => `${conflict.resource.type}:${conflict.resource.key}`)
    assert.ok(found.includes('loader-entry:memory-entry'))
    assert.ok(found.includes('bundle:dsh-bundle-a'))
  } finally {
    await cleanup(home)
  }
})

test('plan renames the later loader id and dedupes bundles', async () => {
  const { home, profileDir } = await makeHome()
  try {
    const graph = await loadGraph({ home, profile: 'web', dir: profileDir })
    const plan = buildPlan(graph)

    const rename = plan.actions.find((action) => action.kind === 'rename-loader-id')
    assert.ok(rename)
    assert.equal(rename.oldId, 'memory-entry')
    assert.equal(rename.newId, 'memory-entry-b')
    assert.equal(rename.occurrence, 2)

    const dedupe = plan.actions.find((action) => action.kind === 'dedupe-bundles')
    assert.ok(dedupe)
    assert.equal(dedupe.key, 'dsh-bundle-a')
  } finally {
    await cleanup(home)
  }
})

test('apply renames the second id, dedupes bundles, and rollback restores', async () => {
  const { home, profileDir } = await makeHome()
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const packageFile = path.join(profileDir, 'package.json')
  const beforePatch = await fs.readFile(patchFile, 'utf8')

  try {
    const graph = await loadGraph({ home, profile: 'web', dir: profileDir })
    const plan = buildPlan(graph)
    const result = await applyPlan({ home, graph, plan })

    assert.ok(result.backup)
    const afterPatch = await fs.readFile(patchFile, 'utf8')
    assert.match(afterPatch, /- id: memory-entry\n/)
    assert.match(afterPatch, /- id: memory-entry-b\n/)
    assert.match(afterPatch, /# keep me/)

    const packageJson = JSON.parse(await fs.readFile(packageFile, 'utf8'))
    assert.deepEqual(packageJson.dsh.profile.bundles, ['dsh-bundle-a', 'dsh-bundle-b'])

    const restored = await rollback(home)
    assert.equal(restored.restored.length, 2)
    assert.equal(await fs.readFile(patchFile, 'utf8'), beforePatch)
  } finally {
    await cleanup(home)
  }
})

test('renameNthLoaderId preserves quotes, comments, and line endings', () => {
  const text = '- insert:\n    - id: "foo" # first\n    - id: "foo" # second\n'
  const result = renameNthLoaderId(text, 'foo', 'foo-b', 2)

  assert.equal(result.ok, true)
  assert.match(result.text, /- id: "foo" # first/)
  assert.match(result.text, /- id: "foo-b" # second/)
})

test('no conflicts means no actions', async () => {
  const { home, profileDir } = await makeHome({ conflicts: false })
  try {
    const graph = await loadGraph({ home, profile: 'web', dir: profileDir })
    assert.equal(graph.conflicts.length, 0)
    assert.equal(buildPlan(graph).actions.length, 0)
  } finally {
    await cleanup(home)
  }
})

test('prefer moves a plugin to the front of the third-party section', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-coexist-prefer-'))
  const profileDir = path.join(home, 'profiles', 'web')
  await fs.mkdir(profileDir, { recursive: true })
  const pkgFile = path.join(profileDir, 'package.json')
  await fs.writeFile(
    pkgFile,
    `${JSON.stringify({
      name: 'fixture',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-coexist-plugin', 'a', 'b'] } },
    }, null, 2)}\n`,
  )

  try {
    const moved = await runPrefer({ home, profile: 'web', plugin: 'b' })
    assert.equal(moved.ok, true)
    assert.deepEqual(moved.order, ['@deepseek-ai/dsh-base', 'dsh-coexist-plugin', 'b', 'a'])

    const pinned = await runPrefer({ home, profile: 'web', plugin: 'dsh-coexist-plugin' })
    assert.equal(pinned.ok, false)
    assert.match(pinned.error, /pinned/)

    const manifest = JSON.parse(await fs.readFile(pkgFile, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-coexist-plugin', 'b', 'a'])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('resolveProfile rejects path traversal and shell metacharacters', () => {
  assert.equal(resolveProfile('/tmp/home', 'desktop').dir, path.join('/tmp/home', 'profiles', 'desktop'))
  for (const name of ['../escape', '..\\escape', 'a/b', 'a&b', 'a|b', 'a b', '%PATH%', '.']) {
    assert.throws(() => resolveProfile('/tmp/home', name), /Invalid profile name/, name)
  }
})

test('detectDependencyCycles finds bundle cycles and ignores external deps', () => {
  const cycles = detectDependencyCycles([
    { name: 'a', dependencies: { b: '1' }, peers: [] },
    { name: 'b', dependencies: { c: '1' }, peers: [] },
    { name: 'c', dependencies: { a: '1' }, peers: [] },
    { name: 'd', dependencies: { external: '1' }, peers: [] },
  ])
  assert.equal(cycles.length, 1)
  assert.deepEqual([...cycles[0]].sort(), ['a', 'b', 'c'])

  assert.deepEqual(
    detectDependencyCycles([
      { name: 'a', dependencies: { b: '1' }, peers: [] },
      { name: 'b', dependencies: {}, peers: [] },
    ]),
    [],
  )
})
