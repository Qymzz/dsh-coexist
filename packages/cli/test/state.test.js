import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  planIdFor,
  readGraph,
  readState,
  saveGraph,
  savePlan,
  validateState,
} from '../src/state.js'
import { rollbackById } from '../src/backup.js'
import { runAudit, runCheck, runList, runPlan } from '../src/commands.js'

const fixturesHome = fileURLToPath(new URL('../../../fixtures/home', import.meta.url))

async function makeHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'coexist-state-'))
}

test('saveGraph/readGraph and savePlan/loadPlan persist state under coexist/', async () => {
  const home = await makeHome()
  const graph = { home, profile: 'web', bundles: ['a'], conflicts: [], logFile: null, logIssues: [] }
  const graphFile = await saveGraph(home, graph)
  assert.equal(path.basename(graphFile), 'graph.json')
  assert.equal((await readGraph(home)).profile, 'web')

  const plan = { actions: [{ kind: 'dedupe-bundles', file: 'x' }] }
  assert.match(planIdFor(plan), /^plan-/)
  const saved = await savePlan(home, plan)
  assert.match(saved.plan.id, /^plan-/)

  const state = await readState(home)
  assert.equal(state.exists, true)
  assert.equal(state.state.plan.id, saved.plan.id)
  assert.equal(state.validation.ok, true)
})

test('validateState rejects malformed state', () => {
  assert.equal(validateState({ version: 1, profile: 'web' }).ok, true)
  assert.equal(validateState({ version: 2, profile: 'web' }).ok, false)
  assert.equal(validateState({ version: 1, profile: '' }).ok, false)
  assert.equal(validateState({ version: 1, profile: 'web', plan: { actions: 1 } }).ok, false)
})

test('rollbackById restores a specific backup and reports missing ids', async () => {
  const home = await makeHome()
  const id = '2026-01-01T00-00-00-000Z'
  const backupDir = path.join(home, 'coexist', 'backups', id)
  const rel = path.join('profiles', 'web', 'package.json')
  const target = path.join(home, rel)
  await fs.mkdir(path.dirname(path.join(backupDir, rel)), { recursive: true })
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(path.join(backupDir, rel), '{"restored":true}\n')
  await fs.writeFile(target, '{"original":true}\n')
  await fs.writeFile(
    path.join(backupDir, 'manifest.json'),
    JSON.stringify({ files: [{ file: target, rel }] }),
  )

  const missing = await rollbackById(home, 'nope')
  assert.match(missing.error, /backup not found/)
  assert.deepEqual(missing.available, [id])

  const result = await rollbackById(home, id)
  assert.deepEqual(result.restored, [target])
  assert.equal(await fs.readFile(target, 'utf8'), '{"restored":true}\n')
})

test('runList reports bundles and conflicts without full scans', async () => {
  const result = await runList({ home: fixturesHome, profile: 'web' })
  assert.equal(result.profile, 'web')
  assert.ok(result.bundles.length > 0)
  assert.ok(Array.isArray(result.conflicts))
})

test('runPlan writes a plan id and plan file', async () => {
  const home = await makeHome()
  await fs.cp(fixturesHome, home, { recursive: true })
  const result = await runPlan({ home, profile: 'web', scanPorts: false, scanLogs: false })
  assert.match(result.plan.id, /^plan-/)
  assert.ok(result.planFile.endsWith(`${result.plan.id}.json`))
  const state = await readState(home)
  assert.equal(state.state.plan.id, result.plan.id)
})

test('runPlan previews changes without touching the original files', async () => {
  const home = await makeHome()
  await fs.cp(fixturesHome, home, { recursive: true })
  const packageFile = path.join(home, 'profiles', 'web', 'package.json')
  const before = await fs.readFile(packageFile, 'utf8')

  const result = await runPlan({ home, profile: 'web', scanPorts: false, scanLogs: false })
  assert.ok(result.plan.preview.files.length > 0)
  assert.ok(result.plan.preview.files.some((file) => file.diff.length > 0))
  assert.equal(await fs.readFile(packageFile, 'utf8'), before)
})

test('runCheck records host version changes', async () => {
  const home = await makeHome()
  await fs.cp(fixturesHome, home, { recursive: true })

  const first = await runCheck({
    home,
    profile: 'web',
    dshVersion: '0.2.0',
    scanPorts: false,
    scanLogs: false,
    scanSources: false,
  })
  assert.equal(first.graph.hostVersion, '0.2.0')
  assert.equal(first.graph.hostChanged, false)

  const second = await runCheck({
    home,
    profile: 'web',
    dshVersion: '0.2.1',
    scanPorts: false,
    scanLogs: false,
    scanSources: false,
  })
  assert.equal(second.graph.hostVersion, '0.2.1')
  assert.equal(second.graph.hostChanged, true)
})

test('runAudit returns newest entries first with a limit', async () => {
  const home = await makeHome()
  await fs.mkdir(path.join(home, 'coexist'), { recursive: true })
  await fs.writeFile(
    path.join(home, 'coexist', 'audit.jsonl'),
    `${JSON.stringify({ at: '1', applied: [] })}\n${JSON.stringify({ at: '2', applied: [] })}\n`,
  )
  const result = await runAudit({ home, limit: 1 })
  assert.equal(result.exists, true)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].at, '2')
})
