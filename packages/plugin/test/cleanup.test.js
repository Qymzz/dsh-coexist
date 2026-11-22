import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanupSelf, installUninstallCleanup } from '../src/cleanup.js'

async function makeHome(manifest = { name: 'p', private: true, dsh: { profile: { bundles: [] } } }) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'coexist-cleanup-'))
  const profileDir = path.join(home, 'profiles', 'desktop')
  await fsp.mkdir(profileDir, { recursive: true })
  await fsp.writeFile(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { home, profileDir }
}

async function stage(profileDir, name) {
  const dir = path.join(profileDir, '.dsh-coexist', 'plugins', name)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'package.json'), '{}\n')
  return dir
}

test('cleanupSelf removes staged copies but keeps coexist data', async () => {
  const { home, profileDir } = await makeHome()
  const plugin = await stage(profileDir, 'dsh-coexist-plugin')
  const cli = await stage(profileDir, 'dsh-coexist-cli')
  await fsp.mkdir(path.join(home, 'coexist', 'backups'), { recursive: true })
  await fsp.writeFile(path.join(home, 'coexist', 'report.json'), '{}')

  const cleaned = await cleanupSelf(home, profileDir)

  assert.equal(fs.existsSync(plugin), false)
  assert.equal(fs.existsSync(cli), false)
  assert.equal(fs.existsSync(path.join(profileDir, '.dsh-coexist')), false)
  assert.equal(fs.existsSync(path.join(home, 'coexist', 'report.json')), true)
  assert.equal(cleaned.length, 2)
})

test('cleanupSelf keeps a legacy launcher when its manifest cannot be restored', async () => {
  const { home, profileDir } = await makeHome()
  const legacy = path.join(home, 'coexist', 'desktop')
  await fsp.mkdir(legacy, { recursive: true })
  await fsp.writeFile(path.join(legacy, 'manifest.json'), '{"entries":[]}\n')

  await cleanupSelf(home, profileDir)

  assert.equal(fs.existsSync(legacy), true)
})

test('cleanupSelf removes a legacy launcher after restore succeeds', async () => {
  const { home, profileDir } = await makeHome()
  const cli = await stage(profileDir, 'dsh-coexist-cli')
  await fsp.mkdir(path.join(cli, 'src'), { recursive: true })
  await fsp.writeFile(
    path.join(cli, 'src', 'desktop.js'),
    'export async function restoreDesktop() { return { restored: [] } }\n',
  )
  const legacy = path.join(home, 'coexist', 'desktop')
  await fsp.mkdir(legacy, { recursive: true })
  await fsp.writeFile(path.join(legacy, 'manifest.json'), '{"entries":[]}\n')

  const result = await cleanupSelf(home, profileDir, { log: () => {} })

  assert.equal(fs.existsSync(legacy), false)
  assert.ok(result.length >= 2)
})

test('host removeBundle triggers cleanup only for the coexist plugin', async () => {
  const { home, profileDir } = await makeHome()
  const plugin = await stage(profileDir, 'dsh-coexist-plugin')
  await fsp.mkdir(path.join(home, 'coexist'), { recursive: true })

  const service = {
    async removeBundle() {
      return { application: 'applied' }
    },
  }
  const ctx = {
    get: (name) => (name === 'pluginManager' ? service : undefined),
    on: () => {},
    effect: () => {},
  }

  installUninstallCleanup(ctx, { home, profile: 'desktop', log: () => {} })
  await service.removeBundle('other-plugin')
  assert.equal(fs.existsSync(plugin), true)

  await service.removeBundle('dsh-coexist-plugin')
  assert.equal(fs.existsSync(plugin), false)
})

test('updateBundle internally removing the plugin does not trigger cleanup', async () => {
  const { home, profileDir } = await makeHome()
  const plugin = await stage(profileDir, 'dsh-coexist-plugin')

  const service = {
    async removeBundle() {
      return { application: 'applied' }
    },
    async updateBundle() {
      return this.removeBundle('dsh-coexist-plugin')
    },
  }
  const ctx = {
    get: (name) => (name === 'pluginManager' ? service : undefined),
    on: () => {},
    effect: () => {},
  }

  installUninstallCleanup(ctx, { home, profile: 'desktop', log: () => {} })
  await service.updateBundle('dsh-coexist-plugin', '0.2.0')
  assert.equal(fs.existsSync(plugin), true)
})
