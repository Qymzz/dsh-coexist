import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadGraph } from '../src/graph.js'
import { buildPlan } from '../src/plan.js'
import { detectLoaderEntryConflicts } from '../src/detectors.js'
import { satisfies, compareVersions, minVersionForRange } from '../src/semver.js'

async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-coexist-detectors-'))
  const profileDir = path.join(home, 'profiles', 'web')
  await fs.mkdir(profileDir, { recursive: true })
  return { home, profileDir }
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function writeBundle(profileDir, name, { patch, peerDependencies, version = '1.0.0' } = {}) {
  const bundleDir = path.join(profileDir, 'node_modules', ...name.split('/'))
  const pkg = { name, version }
  if (patch) pkg.dsh = { bundle: { patch: './cordis.patch.yml' } }
  if (peerDependencies) pkg.peerDependencies = peerDependencies
  await writeFile(path.join(bundleDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  if (patch) await writeFile(path.join(bundleDir, 'cordis.patch.yml'), patch)
}

async function seedProfile(profileDir, bundles, patch) {
  await writeFile(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'fixture-profile', dsh: { profile: { bundles } } }, null, 2)}\n`,
  )
  if (patch) await writeFile(path.join(profileDir, 'cordis.patch.yml'), patch)
}

async function cleanup(home) {
  await fs.rm(home, { recursive: true, force: true })
}

test('semver satisfies supports common npm ranges', () => {
  assert.equal(satisfies('1.2.3', '^1.2.0'), true)
  assert.equal(satisfies('2.0.0', '^1.2.0'), false)
  assert.equal(satisfies('1.2.9', '~1.2.0'), true)
  assert.equal(satisfies('1.3.0', '~1.2.0'), false)
  assert.equal(satisfies('0.2.5', '^0.2.3'), true)
  assert.equal(satisfies('0.3.0', '^0.2.3'), false)
  assert.equal(satisfies('1.2.3', '>=1.0.0 <2.0.0'), true)
  assert.equal(satisfies('1.2.3', '1.2'), true)
  assert.equal(satisfies('1.3.0', '1.2'), false)
  assert.equal(satisfies('1.2.3', '^1.2.0 || ^2.0.0'), true)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1)
  assert.equal(minVersionForRange('^2.0.0'), '2.0.0')
  assert.equal(minVersionForRange('>=1.5.0 <2.0.0'), '1.5.0')
  assert.equal(minVersionForRange('^1.0.0 || ^3.0.0'), '3.0.0')
  assert.equal(minVersionForRange('nonsense'), null)
})

test('scans bundle internal patches and reports cross-layer duplicate ids', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await writeBundle(profileDir, 'pkg-a', {
      patch: `- insert:
    - id: shared-entry
      name: plugin-a
`,
    })
    await writeBundle(profileDir, 'pkg-b', {
      patch: `- insert:
    - id: shared-entry
      name: plugin-b
`,
    })
    await seedProfile(profileDir, ['pkg-a', 'pkg-b'])

    const graph = await loadGraph({ home, profile: 'web', dir: profileDir, scanPorts: false })
    const conflict = graph.conflicts.find(
      (item) => item.resource.type === 'loader-entry' && item.resource.key === 'shared-entry',
    )
    assert.ok(conflict)
    assert.deepEqual(conflict.rows.map((row) => row.source), ['bundle:pkg-a', 'bundle:pkg-b'])

    const plan = buildPlan(graph)
    const kinds = plan.actions.map((action) => action.kind)
    assert.ok(kinds.includes('disable-loader-row'))
    assert.ok(kinds.includes('clone-loader-row'))
    assert.equal(
      plan.actions.some((action) => action.kind === 'rename-loader-id'),
      false,
    )
  } finally {
    await cleanup(home)
  }
})

test('renames the editable profile row when only the bundle row is earlier', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await writeBundle(profileDir, 'pkg-a', {
      patch: `- insert:
    - id: shared-entry
      name: plugin-a
`,
    })
    await seedProfile(
      profileDir,
      ['pkg-a'],
      `- insert:
    - id: shared-entry
      name: plugin-b
`,
    )

    const graph = await loadGraph({ home, profile: 'web', dir: profileDir, scanPorts: false })
    const plan = buildPlan(graph)
    const rename = plan.actions.find((action) => action.kind === 'rename-loader-id')
    assert.ok(rename)
    assert.equal(rename.file, path.join(profileDir, 'cordis.patch.yml'))
    assert.equal(rename.newId, 'shared-entry-b')
  } finally {
    await cleanup(home)
  }
})

test('reports a replace that silently re-enables a disabled entry', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await writeBundle(profileDir, 'pkg-a', {
      patch: `- insert:
    - id: alpha
      name: plugin-alpha
      disabled: true
      config:
        mode: off
`,
    })
    await seedProfile(
      profileDir,
      ['pkg-a'],
      `- replace:
    - id: alpha
      name: plugin-alpha
      config:
        mode: on
`,
    )

    const graph = await loadGraph({ home, profile: 'web', dir: profileDir, scanPorts: false })
    const conflict = graph.conflicts.find(
      (item) => item.resource.type === 'patch-override' && item.resource.key === 'alpha',
    )
    assert.ok(conflict)
    assert.equal(conflict.severity, 'conflict')
    assert.match(conflict.detail, /disabled/)

    const plan = buildPlan(graph)
    assert.ok(
      plan.actions.some(
        (action) => action.kind === 'append-patch' && action.targetId === 'alpha',
      ),
    )
  } finally {
    await cleanup(home)
  }
})

test('partial config override is informational and does not enter the plan', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await writeBundle(profileDir, 'pkg-a', {
      patch: `- insert:
    - id: beta
      name: plugin-beta
      config:
        a: 1
        b: 2
`,
    })
    await seedProfile(
      profileDir,
      ['pkg-a'],
      `- replace:
    - id: beta
      name: plugin-beta
      config:
        a: 1
`,
    )

    const graph = await loadGraph({ home, profile: 'web', dir: profileDir, scanPorts: false })
    const conflict = graph.conflicts.find(
      (item) => item.resource.type === 'patch-override' && item.resource.key === 'beta',
    )
    assert.ok(conflict)
    assert.equal(conflict.severity, 'info')
    assert.match(conflict.detail, /b/)

    const plan = buildPlan(graph)
    assert.equal(
      plan.actions.some((action) => action.conflict?.resource.key === 'beta'),
      false,
    )
  } finally {
    await cleanup(home)
  }
})

test('reports a replace whose target does not exist in earlier layers', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await seedProfile(
      profileDir,
      [],
      `- replace:
    - id: ghost
      name: plugin-ghost
`,
    )

    const graph = await loadGraph({ home, profile: 'web', dir: profileDir, scanPorts: false })
    const conflict = graph.conflicts.find((item) => item.resource.type === 'patch-dangling-replace')
    assert.ok(conflict)
    assert.equal(conflict.resource.key, 'ghost')
  } finally {
    await cleanup(home)
  }
})

test('reports an unsatisfied peer and skips host-provided peers', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await writeBundle(profileDir, 'pkg-a', {
      peerDependencies: {
        'demo-lib': '^2.0.0',
        '@deepseek-ai/dsh': '^0.3.0',
      },
    })
    await writeFile(
      path.join(profileDir, 'node_modules', 'demo-lib', 'package.json'),
      `${JSON.stringify({ name: 'demo-lib', version: '1.5.0' }, null, 2)}\n`,
    )
    await seedProfile(profileDir, ['pkg-a'])

    const graph = await loadGraph({ home, profile: 'web', dir: profileDir, scanPorts: false })
    const peers = graph.conflicts.filter((item) => item.resource.type === 'peer')
    assert.equal(peers.length, 1)
    assert.equal(peers[0].resource.key, 'demo-lib')
    assert.match(peers[0].detail, /\^2\.0\.0/)
    assert.match(peers[0].detail, /1\.5\.0/)
    assert.equal(peers[0].suggestedVersion, '2.0.0')
  } finally {
    await cleanup(home)
  }
})

test('reports duplicate declared ports and marks occupied ones', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await writeBundle(profileDir, 'pkg-a', {
      patch: `- insert:
    - id: server-a
      name: plugin-a
      config:
        server:
          port: 4100
`,
    })
    await writeBundle(profileDir, 'pkg-b', {
      patch: `- insert:
    - id: server-b
      name: plugin-b
      config:
        port: 4100
`,
    })
    await seedProfile(profileDir, ['pkg-a', 'pkg-b'])

    const graph = await loadGraph({
      home,
      profile: 'web',
      dir: profileDir,
      probePort: async (port) => port === 4100,
    })
    const conflict = graph.conflicts.find(
      (item) => item.resource.type === 'port' && item.resource.key === '4100',
    )
    assert.ok(conflict)
    assert.deepEqual(conflict.owners, ['plugin-a', 'plugin-b'])
    assert.match(conflict.detail, /已被占用/)
  } finally {
    await cleanup(home)
  }
})

test('unparseable bundle patch is reported without aborting the scan', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await writeBundle(profileDir, 'pkg-a', { patch: '- insert: [unclosed\n' })
    await seedProfile(profileDir, ['pkg-a'])

    const graph = await loadGraph({ home, profile: 'web', dir: profileDir, scanPorts: false })
    const info = graph.bundleInfo.find((bundle) => bundle.name === 'pkg-a')
    assert.ok(info.patchError)
    assert.deepEqual(graph.conflicts, [])
  } finally {
    await cleanup(home)
  }
})

test('clean bundle patch and full replace produce no conflicts', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await writeBundle(profileDir, 'pkg-a', {
      patch: `- insert:
    - id: gamma
      name: plugin-gamma
      config:
        a: 1
        b: 2
`,
      peerDependencies: { 'demo-lib': '^1.0.0' },
    })
    await writeFile(
      path.join(profileDir, 'node_modules', 'demo-lib', 'package.json'),
      `${JSON.stringify({ name: 'demo-lib', version: '1.4.0' }, null, 2)}\n`,
    )
    await seedProfile(
      profileDir,
      ['pkg-a'],
      `- replace:
    - id: gamma
      name: plugin-gamma
      config:
        a: 1
        b: 2
`,
    )

    const graph = await loadGraph({ home, profile: 'web', dir: profileDir, scanPorts: false })
    assert.deepEqual(graph.conflicts, [])
    assert.equal(buildPlan(graph).actions.length, 0)
  } finally {
    await cleanup(home)
  }
})

test('same-name profile row overrides a bundle row without a conflict', () => {
  const conflicts = detectLoaderEntryConflicts([
    { op: 'insert', id: 'coexist', name: 'dsh-coexist-plugin', file: 'bundle', source: 'bundle' },
    { op: 'row', id: 'coexist', name: 'dsh-coexist-plugin', file: 'profile', source: 'profile' },
    { op: 'insert', id: 'side-chat', name: 'plugin-a', file: 'a', source: 'bundle' },
    { op: 'insert', id: 'side-chat', name: 'plugin-b', file: 'b', source: 'bundle' },
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].resource.key, 'side-chat')
})
