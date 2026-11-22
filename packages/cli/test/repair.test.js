import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadGraph } from '../src/graph.js'
import { buildPlan } from '../src/plan.js'
import { applyPlan, replacePortInRow } from '../src/apply.js'

async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'coexist-repair-'))
  const profileDir = path.join(home, 'profiles', 'web')
  await fs.mkdir(profileDir, { recursive: true })
  return { home, profileDir }
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function seedProfile(profileDir, bundles, patch) {
  await writeFile(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'fixture-profile', dsh: { profile: { bundles } } }, null, 2)}\n`,
  )
  if (patch) await writeFile(path.join(profileDir, 'cordis.patch.yml'), patch)
}

async function writeBundle(profileDir, name, patch) {
  const dir = path.join(profileDir, 'node_modules', name)
  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2)}\n`,
  )
  await writeFile(path.join(dir, 'cordis.patch.yml'), patch)
}

async function cleanup(home) {
  await fs.rm(home, { recursive: true, force: true })
}

test('bundle-owned loader id conflict is disabled and cloned into the profile patch', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await seedProfile(profileDir, ['bundle-a', 'bundle-b'])
    await writeBundle(
      profileDir,
      'bundle-a',
      '- insert:\n    - id: shared-entry\n      name: plugin-a\n',
    )
    await writeBundle(
      profileDir,
      'bundle-b',
      '- insert:\n    - id: shared-entry\n      name: plugin-b\n      config:\n        port: 4100\n',
    )

    const graph = await loadGraph({
      home,
      profile: 'web',
      dir: profileDir,
      scanPorts: false,
      scanLogs: false,
      scanSources: false,
    })
    const plan = buildPlan(graph)
    const kinds = plan.actions.map((action) => action.kind)
    assert.ok(kinds.includes('disable-loader-row'))
    assert.ok(kinds.includes('clone-loader-row'))
    assert.equal(kinds.includes('rename-loader-id'), false)

    await applyPlan({ home, graph, plan })
    const patch = await fs.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /id: shared-entry\n\s+disabled: true/)
    assert.match(patch, /id: shared-entry-b/)
    assert.match(patch, /name: plugin-b/)
    assert.match(patch, /port: 4100/)
  } finally {
    await cleanup(home)
  }
})

test('log scan extracts historical conflict evidence', async () => {
  const { home, profileDir } = await makeHome()
  try {
    await seedProfile(profileDir, [])
    await writeFile(
      path.join(home, 'logs', 'desktop.log'),
      [
        '2026-11-22T00:00:00Z Error: tool "memory_search" is already registered',
        '2026-11-22T00:00:01Z Error: service "demoShared" has been registered at <plugin-a>',
        '2026-11-22T00:00:02Z Error: listen EADDRINUSE: address already in use 127.0.0.1:4100',
        '2026-11-22T00:00:03Z npm ERR! ERESOLVE unable to resolve dependency tree',
      ].join('\n'),
    )

    const graph = await loadGraph({
      home,
      profile: 'web',
      dir: profileDir,
      scanPorts: false,
    })

    const types = new Set(graph.logIssues.map((issue) => issue.type))
    assert.ok(types.has('tool'))
    assert.ok(types.has('service'))
    assert.ok(types.has('port'))
    assert.ok(types.has('peer'))
    assert.match(graph.logFile, /desktop\.log$/)

    const port = graph.logIssues.find((issue) => issue.type === 'port')
    assert.equal(port.key, '4100')
  } finally {
    await cleanup(home)
  }
})

test('replacePortInRow keeps indentation and comments', () => {
  const text = `- insert:
    - id: server-a # keep me
      config:
        port: 4100
    - id: server-b
      config:
        port: 4100
`
  const result = replacePortInRow(text, 'server-b', 4100, 4101)
  assert.equal(result.ok, true)
  assert.match(result.text, /server-a # keep me\n      config:\n        port: 4100/)
  assert.match(result.text, /server-b\n      config:\n        port: 4101/)
})

test('plan and apply change a conflicting editable port', async () => {
  const { home, profileDir } = await makeHome()
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  try {
    await seedProfile(
      profileDir,
      [],
      `- insert:
    - id: server-a
      name: plugin-a
      config:
        server:
          port: 4100
    - id: server-b
      name: plugin-b
      config:
        port: 4100
`,
    )

    const graph = await loadGraph({
      home,
      profile: 'web',
      dir: profileDir,
      scanPorts: false,
      scanLogs: false,
    })
    assert.ok(graph.conflicts.some((conflict) => conflict.resource.type === 'port'))

    const plan = buildPlan(graph)
    const change = plan.actions.find((action) => action.kind === 'change-port')
    assert.ok(change)
    assert.equal(change.id, 'server-b')
    assert.equal(change.oldPort, 4100)
    assert.equal(change.newPort, 4101)

    await applyPlan({ home, graph, plan })
    const text = await fs.readFile(patchFile, 'utf8')
    assert.match(text, /port: 4100/)
    assert.match(text, /port: 4101/)

    const after = await loadGraph({
      home,
      profile: 'web',
      dir: profileDir,
      scanPorts: false,
      scanLogs: false,
    })
    assert.equal(
      after.conflicts.some((conflict) => conflict.resource.type === 'port'),
      false,
    )
  } finally {
    await cleanup(home)
  }
})

test('N 个端口声明一次修完', async () => {
  const { home, profileDir } = await makeHome()
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  try {
    await seedProfile(
      profileDir,
      [],
      `- insert:
    - id: server-a
      name: plugin-a
      config:
        port: 4200
    - id: server-b
      name: plugin-b
      config:
        port: 4200
    - id: server-c
      name: plugin-c
      config:
        port: 4200
`,
    )

    const graph = await loadGraph({
      home,
      profile: 'web',
      dir: profileDir,
      scanPorts: false,
      scanLogs: false,
    })
    const plan = buildPlan(graph)
    const changes = plan.actions.filter((action) => action.kind === 'change-port')
    assert.equal(changes.length, 2)
    assert.deepEqual(changes.map((action) => action.newPort).sort(), [4201, 4202])

    await applyPlan({ home, graph, plan })
    const text = await fs.readFile(patchFile, 'utf8')
    assert.match(text, /port: 4200/)
    assert.match(text, /port: 4201/)
    assert.match(text, /port: 4202/)

    const after = await loadGraph({
      home,
      profile: 'web',
      dir: profileDir,
      scanPorts: false,
      scanLogs: false,
    })
    assert.equal(
      after.conflicts.some((conflict) => conflict.resource.type === 'port'),
      false,
    )
  } finally {
    await cleanup(home)
  }
})

test('peer override is opt-in and writes pnpm overrides', async () => {
  const { home, profileDir } = await makeHome()
  const packageFile = path.join(profileDir, 'package.json')
  try {
    const bundleDir = path.join(profileDir, 'node_modules', 'pkg-a')
    await writeFile(
      path.join(bundleDir, 'package.json'),
      `${JSON.stringify(
        { name: 'pkg-a', version: '1.0.0', peerDependencies: { 'demo-lib': '^2.0.0' } },
        null,
        2,
      )}\n`,
    )
    await writeFile(
      path.join(profileDir, 'node_modules', 'demo-lib', 'package.json'),
      `${JSON.stringify({ name: 'demo-lib', version: '1.5.0' }, null, 2)}\n`,
    )
    await seedProfile(profileDir, ['pkg-a'])
    await writeFile(path.join(profileDir, 'pnpm-lock.yaml'), '')

    const graph = await loadGraph({
      home,
      profile: 'web',
      dir: profileDir,
      scanPorts: false,
      scanLogs: false,
    })
    assert.ok(graph.conflicts.some((conflict) => conflict.resource.type === 'peer'))

    const defaultPlan = buildPlan(graph)
    assert.equal(
      defaultPlan.actions.some((action) => action.kind === 'peer-override'),
      false,
    )

    const plan = buildPlan(graph, { allowPeerOverride: true })
    const action = plan.actions.find((item) => item.kind === 'peer-override')
    assert.ok(action)
    assert.equal(action.dep, 'demo-lib')
    assert.equal(action.version, '2.0.0')

    await applyPlan({ home, graph, plan })
    const packageJson = JSON.parse(await fs.readFile(packageFile, 'utf8'))
    assert.equal(packageJson.pnpm.overrides['demo-lib'], '2.0.0')
  } finally {
    await cleanup(home)
  }
})

test('plan and apply append a full merged patch row', async () => {
  const { home, profileDir } = await makeHome()
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  try {
    await writeBundle(
      profileDir,
      'pkg-a',
      `- insert:
    - id: alpha
      name: plugin-alpha
      disabled: true
      config:
        a: 1
        b: 2
`,
    )
    await seedProfile(
      profileDir,
      ['pkg-a'],
      `- replace:
    - id: alpha
      name: plugin-alpha
      config:
        a: 1
`,
    )

    const graph = await loadGraph({
      home,
      profile: 'web',
      dir: profileDir,
      scanPorts: false,
      scanLogs: false,
    })
    const override = graph.conflicts.find(
      (conflict) =>
        conflict.resource.type === 'patch-override' && conflict.severity === 'conflict',
    )
    assert.ok(override)

    const plan = buildPlan(graph)
    const append = plan.actions.find((action) => action.kind === 'append-patch')
    assert.ok(append)
    assert.equal(append.file, patchFile)
    assert.equal(append.targetId, 'alpha')

    await applyPlan({ home, graph, plan })
    const text = await fs.readFile(patchFile, 'utf8')
    assert.match(text, /# dsh-coexist: patch-override alpha/)
    assert.match(text, /disabled: true/)
    assert.match(text, /b: 2/)

    const after = await loadGraph({
      home,
      profile: 'web',
      dir: profileDir,
      scanPorts: false,
      scanLogs: false,
    })
    assert.equal(
      after.conflicts.some(
        (conflict) =>
          conflict.resource.type === 'patch-override' && conflict.severity === 'conflict',
      ),
      false,
    )
  } finally {
    await cleanup(home)
  }
})
