import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  readAsarJson,
  detectDshVersion,
  evaluateCompatibility,
  installPlugin,
  uninstallPlugin,
  buildMatrix,
  snapshotNodeModules,
  restorePrunedPackages,
} from '../src/installer.js'

async function makeHome(manifest = { name: 'p', private: true, dsh: { profile: { bundles: [] } } }) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'coexist-install-'))
  const profileDir = path.join(home, 'profiles', 'desktop')
  await fsp.mkdir(profileDir, { recursive: true })
  await fsp.writeFile(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return { home, profileDir }
}

async function makePlugin(name, manifest = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'coexist-plugin-'))
  const pkg = {
    name,
    version: '1.0.0',
    main: 'index.js',
    ...manifest,
  }
  await fsp.writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  await fsp.writeFile(path.join(dir, 'index.js'), 'export default {}\n')
  return dir
}

/** 构造一个只含单个条目的最小 asar，用来验证版本检测。 */
function writeAsar(file, entries) {
  const root = { files: {} }
  const contents = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, 'utf8')
    const parts = name.replace(/^\//, '').split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} }
      node = node.files[part]
    }
    node.files[parts[parts.length - 1]] = { size: data.length, offset }
    contents.push(data)
    offset += data.length
  }
  const json = JSON.stringify(root)
  const jsonLen = Buffer.byteLength(json)
  const padding = (4 - (jsonLen % 4)) % 4
  const size = 8 + jsonLen + padding

  const header = Buffer.alloc(16)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(size, 4)
  header.writeUInt32LE(jsonLen, 12)

  const padded = Buffer.alloc(jsonLen + padding)
  padded.write(json, 0, 'utf8')

  fs.writeFileSync(file, Buffer.concat([header, padded, ...contents]))
}

test('readAsarJson reads nested entries with the pickled header', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'coexist-asar-'))
  const asar = path.join(home, 'app.asar')
  writeAsar(asar, {
    '/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.4' }),
  })
  const manifest = readAsarJson(asar, '/node_modules/@deepseek-ai/dsh/package.json')
  assert.equal(manifest.version, '0.2.1-rc.4')
})

test('detectDshVersion prefers an explicit version over the desktop app', () => {
  const host = detectDshVersion({ dshVersion: '0.2.1-rc.4', home: os.tmpdir(), profile: 'desktop' })
  assert.equal(host.version, '0.2.1-rc.4')
  assert.equal(host.source, 'env')
})

test('evaluateCompatibility blocks a failing engine range and reports unknown peers', () => {
  const manifest = {
    name: 'x',
    engines: { dsh: '>=0.3.0' },
    peerDependencies: { '@deepseek-ai/not-installed': '^1.0.0' },
  }
  const result = evaluateCompatibility(manifest, { version: '0.2.1-rc.4' }, os.tmpdir())
  assert.equal(result.status, 'blocked')
  assert.equal(result.checks.find((check) => check.kind === 'engine').ok, false)
  assert.equal(result.checks.find((check) => check.kind === 'peer').ok, null)
})

test('installPlugin copies a local plugin, adds dependency and bundle', async () => {
  const { home, profileDir } = await makeHome()
  const pluginDir = await makePlugin('dsh-demo')

  const result = await installPlugin({
    home,
    profile: 'desktop',
    dshVersion: '0.2.1-rc.4',
    spec: pluginDir,
    runCommand: async () => {
      throw new Error('no package manager in test')
    },
  })

  assert.equal(result.ok, true, result.error)
  const manifest = JSON.parse(await fsp.readFile(path.join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['dsh-demo'], 'file:.dsh-coexist/plugins/dsh-demo')
  assert.deepEqual(manifest.dsh.profile.bundles, ['dsh-demo'])
  assert.equal(
    await fsp.readFile(path.join(profileDir, 'node_modules', 'dsh-demo', 'index.js'), 'utf8'),
    'export default {}\n',
  )
})

test('installPlugin rolls back when the installed package is broken', async () => {
  const original = { name: 'p', private: true, dsh: { profile: { bundles: ['keep-me'] } } }
  const { home, profileDir } = await makeHome(original)
  const pluginDir = await makePlugin('dsh-broken', { main: 'missing.js' })

  const result = await installPlugin({
    home,
    profile: 'desktop',
    dshVersion: '0.2.1-rc.4',
    spec: pluginDir,
    runCommand: async () => {
      throw new Error('no package manager in test')
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, true)
  const manifest = JSON.parse(await fsp.readFile(path.join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['keep-me'])
  assert.equal(manifest.dependencies, undefined)
})

test('installPlugin refuses an incompatible plugin unless forced', async () => {
  const { home } = await makeHome()
  const pluginDir = await makePlugin('dsh-future', { engines: { dsh: '>=0.3.0' } })

  const blocked = await installPlugin({
    home,
    profile: 'desktop',
    dshVersion: '0.2.1-rc.4',
    spec: pluginDir,
    runCommand: async () => {
      throw new Error('should not run')
    },
  })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /not compatible/)

  const dry = await installPlugin({
    home,
    profile: 'desktop',
    dshVersion: '0.2.1-rc.4',
    spec: pluginDir,
    dryRun: true,
  })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.compatibility.status, 'blocked')
})

test('uninstallPlugin removes the bundle, dependency and staged copy', async () => {
  const { home, profileDir } = await makeHome({
    name: 'p',
    dependencies: { 'dsh-demo': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-demo', 'other'] } },
  })
  await fsp.mkdir(path.join(profileDir, 'node_modules', 'dsh-demo'), { recursive: true })
  await fsp.mkdir(path.join(profileDir, '.dsh-coexist', 'plugins', 'dsh-demo'), { recursive: true })

  const result = await uninstallPlugin({
    home,
    profile: 'desktop',
    spec: 'dsh-demo',
    runCommand: async () => {
      throw new Error('no package manager in test')
    },
  })

  assert.deepEqual(result.removed.sort(), ['bundles', 'dependencies'])
  const manifest = JSON.parse(await fsp.readFile(path.join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['other'])
  assert.equal(manifest.dependencies['dsh-demo'], undefined)
  assert.equal(fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-demo')), false)
  assert.equal(fs.existsSync(path.join(profileDir, '.dsh-coexist', 'plugins', 'dsh-demo')), false)
  assert.equal(fs.existsSync(path.join(profileDir, '.dsh-coexist')), false)
  assert.ok(result.cleaned.some((item) => item.includes('dsh-demo')))
})

test('uninstalling the coexist plugin removes the staged CLI and purges coexist data', async () => {
  const { home, profileDir } = await makeHome({
    name: 'p',
    dependencies: { 'dsh-coexist-plugin': 'file:.dsh-coexist/plugins/dsh-coexist-plugin' },
    dsh: { profile: { bundles: ['dsh-coexist-plugin'] } },
  })
  const staged = path.join(profileDir, '.dsh-coexist', 'plugins')
  await fsp.mkdir(path.join(staged, 'dsh-coexist-plugin'), { recursive: true })
  await fsp.mkdir(path.join(staged, 'dsh-coexist-cli'), { recursive: true })
  await fsp.mkdir(path.join(profileDir, 'node_modules', 'dsh-coexist-plugin'), { recursive: true })
  await fsp.mkdir(path.join(home, 'coexist', 'backups'), { recursive: true })
  await fsp.writeFile(path.join(home, 'coexist', 'report.json'), '{}')

  const result = await uninstallPlugin({
    home,
    profile: 'desktop',
    spec: 'dsh-coexist-plugin',
    purge: true,
    runCommand: async () => {
      throw new Error('no package manager in test')
    },
  })

  assert.equal(fs.existsSync(path.join(staged, 'dsh-coexist-plugin')), false)
  assert.equal(fs.existsSync(path.join(staged, 'dsh-coexist-cli')), false)
  assert.equal(fs.existsSync(path.join(profileDir, '.dsh-coexist')), false)
  assert.equal(fs.existsSync(path.join(home, 'coexist')), false)
  assert.equal(result.purged, true)
})

test('buildMatrix marks host bundles, installed plugins and missing packages', async () => {
  const { home, profileDir } = await makeHome({
    name: 'p',
    dependencies: { 'dsh-demo': '1.0.0', 'dsh-gone': '1.0.0' },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', 'dsh-demo', 'dsh-gone'],
      },
    },
  })
  const pluginDir = path.join(profileDir, 'node_modules', 'dsh-demo')
  await fsp.mkdir(pluginDir, { recursive: true })
  await fsp.writeFile(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: 'dsh-demo', version: '1.0.0', engines: { dsh: '>=0.2.0' } }),
  )

  const matrix = await buildMatrix({ home, profile: 'desktop', dshVersion: '0.2.1-rc.4' })
  const byName = Object.fromEntries(matrix.rows.map((row) => [row.name, row]))
  assert.equal(byName['dsh-demo'].status, 'ok')
  assert.equal(byName['dsh-gone'].status, 'missing')
  // 桌面安装存在时宿主包从 asar 读到版本（host）；没有桌面安装的机器上是 missing。
  assert.ok(['host', 'missing'].includes(byName['@deepseek-ai/dsh-base'].status))
})

test('installPlugin stages the CLI dependency for the coexist plugin', async () => {
  const { home, profileDir } = await makeHome()
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'coexist-self-'))
  const pluginDir = path.join(root, 'plugin')
  const cliDir = path.join(root, 'cli')
  await fsp.mkdir(pluginDir, { recursive: true })
  await fsp.mkdir(path.join(cliDir, 'bin'), { recursive: true })
  await fsp.writeFile(
    path.join(pluginDir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-coexist-plugin',
      version: '0.1.0',
      main: 'index.js',
      dependencies: { 'dsh-coexist-cli': '^0.1.0' },
    }, null, 2)}\n`,
  )
  await fsp.writeFile(path.join(pluginDir, 'index.js'), 'export default {}\n')
  await fsp.writeFile(
    path.join(cliDir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-coexist-cli',
      version: '0.1.0',
      bin: { 'dsh-coexist': './bin/dsh-coexist.js' },
    }, null, 2)}\n`,
  )
  await fsp.writeFile(path.join(cliDir, 'bin', 'dsh-coexist.js'), '#!/usr/bin/env node\n')

  try {
    const result = await installPlugin({
      home,
      profile: 'desktop',
      dshVersion: '0.2.1-rc.4',
      spec: pluginDir,
      runCommand: async () => {
        throw new Error('no package manager in test')
      },
    })

    assert.equal(result.ok, true, result.error)
    assert.equal(
      fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-coexist-cli', 'bin', 'dsh-coexist.js')),
      true,
    )
    const installed = JSON.parse(
      await fsp.readFile(path.join(profileDir, 'node_modules', 'dsh-coexist-plugin', 'package.json'), 'utf8'),
    )
    assert.equal(installed.dependencies['dsh-coexist-cli'], 'file:../dsh-coexist-cli')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('snapshotNodeModules lists scoped packages and skips .ignored', async () => {
  const { profileDir } = await makeHome()
  const nm = path.join(profileDir, 'node_modules')
  await fsp.mkdir(path.join(nm, '@scope', 'a'), { recursive: true })
  await fsp.mkdir(path.join(nm, 'plain'), { recursive: true })
  await fsp.mkdir(path.join(nm, '.ignored', 'gone'), { recursive: true })

  const names = snapshotNodeModules(profileDir)
  assert.deepEqual([...names].sort(), ['@scope/a', 'plain'])
})

test('restorePrunedPackages copies packages back from .ignored', async () => {
  const { profileDir } = await makeHome()
  const nm = path.join(profileDir, 'node_modules')
  const source = path.join(nm, '.ignored', '@scope', 'peer')
  await fsp.mkdir(source, { recursive: true })
  await fsp.writeFile(path.join(source, 'package.json'), '{"name":"@scope/peer"}')

  const restored = await restorePrunedPackages(profileDir, new Set(['@scope/peer', 'missing']))
  assert.deepEqual(restored, ['@scope/peer'])
  assert.equal(fs.existsSync(path.join(nm, '@scope', 'peer', 'package.json')), true)
})

test('installPlugin tracks the coexist plugin so a package manager keeps it', async () => {
  const { home, profileDir } = await makeHome({
    name: 'p',
    dsh: { profile: { bundles: ['dsh-coexist-plugin'] } },
  })
  const coexist = path.join(profileDir, 'node_modules', 'dsh-coexist-plugin')
  await fsp.mkdir(coexist, { recursive: true })
  await fsp.writeFile(path.join(coexist, 'package.json'), '{"name":"dsh-coexist-plugin","version":"0.1.0"}')
  const pluginDir = await makePlugin('dsh-demo')

  const result = await installPlugin({
    home,
    profile: 'desktop',
    dshVersion: '0.2.1-rc.4',
    spec: pluginDir,
    runCommand: async () => {
      throw new Error('no package manager in test')
    },
  })

  assert.equal(result.ok, true, result.error)
  const manifest = JSON.parse(await fsp.readFile(path.join(profileDir, 'package.json'), 'utf8'))
  assert.equal(
    manifest.dependencies['dsh-coexist-plugin'],
    'file:.dsh-coexist/plugins/dsh-coexist-plugin',
  )
  assert.equal(
    fs.existsSync(path.join(profileDir, '.dsh-coexist', 'plugins', 'dsh-coexist-plugin', 'package.json')),
    true,
  )
})

test('uninstallPlugin restores packages pruned by the package manager', async () => {
  const { home, profileDir } = await makeHome({
    name: 'p',
    dependencies: { 'dsh-demo': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-demo'] } },
  })
  const nm = path.join(profileDir, 'node_modules')
  await fsp.mkdir(path.join(nm, 'dsh-demo'), { recursive: true })
  await fsp.writeFile(path.join(nm, 'dsh-demo', 'package.json'), '{"name":"dsh-demo"}')
  await fsp.mkdir(path.join(nm, 'peer'), { recursive: true })
  await fsp.writeFile(path.join(nm, 'peer', 'package.json'), '{"name":"peer"}')

  const result = await uninstallPlugin({
    home,
    profile: 'desktop',
    spec: 'dsh-demo',
    runCommand: async () => {
      await fsp.mkdir(path.join(nm, '.ignored'), { recursive: true })
      await fsp.rename(path.join(nm, 'peer'), path.join(nm, '.ignored', 'peer'))
      throw new Error('no package manager in test')
    },
  })

  assert.deepEqual(result.restoredPackages, ['peer'])
  assert.equal(fs.existsSync(path.join(nm, 'peer', 'package.json')), true)
  assert.equal(fs.existsSync(path.join(nm, 'dsh-demo')), false)
})
