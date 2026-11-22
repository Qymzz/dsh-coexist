import fs from 'node:fs/promises'
import path from 'node:path'
import { auditFile, profilePackageJson, resolveHome, resolveProfile, reportFile } from './paths.js'
import { loadGraph } from './graph.js'
import { buildPlan } from './plan.js'
import { applyPlan } from './apply.js'
import { createBackup, listBackups, rollback, rollbackById } from './backup.js'
import { readJson } from './load.js'
import { planIdFor, loadPlan, readState, saveGraph, savePlan, writeState } from './state.js'
import { dumpConfig } from './dumpconfig.js'
import { previewPlan } from './preview.js'
import { detectDshVersion, reinstallDependencies } from './installer.js'

async function context(options) {
  const home = resolveHome(options.home)
  const profile = resolveProfile(home, options.profile)
  const graph = await loadGraph({
    home,
    ...profile,
    probePort: options.probePort,
    scanPorts: options.scanPorts,
    scanLogs: options.scanLogs,
    scanSources: options.scanSources,
    logFile: options.logFile,
  })
  return { home, profile, graph }
}

function withMetadata(plan, graph) {
  return {
    ...plan,
    id: plan.id ?? planIdFor(plan),
    createdAt: plan.createdAt ?? new Date().toISOString(),
    profile: graph.profile,
    home: graph.home,
  }
}

export async function runCheck(options = {}) {
  const { home, graph } = await context(options)
  const host = detectDshVersion({
    home,
    profile: graph.profile,
    dshVersion: options.dshVersion,
    app: options.app,
  })
  const previous = (await readState(home)).state?.hostVersion ?? null
  graph.hostVersion = host.version
  graph.hostChanged = Boolean(previous && host.version && previous !== host.version)

  const graphFile = await saveGraph(home, graph)
  await writeState(home, {
    profile: graph.profile,
    hostVersion: host.version,
    hostChangedAt: graph.hostChanged ? new Date().toISOString() : undefined,
    lastCheckAt: new Date().toISOString(),
    conflicts: graph.conflicts.length,
  })
  return { graph, graphFile }
}

export async function runPlan(options = {}) {
  const { home, profile, graph } = await context(options)
  const plan = withMetadata(
    buildPlan(graph, { allowPeerOverride: options.allowPeerOverride }),
    graph,
  )

  const graphFile = await saveGraph(home, graph)
  const saved = await savePlan(home, plan)
  plan.id = saved.plan.id

  if (options.diff !== false) {
    plan.preview = await previewPlan({ home, graph, plan })
  }

  if (options.dumpConfig) {
    plan.dumpConfig = await dumpConfig({
      home,
      profile: profile.profile,
      dshBin: options.dshBin,
    })
  }

  return { graph, plan, graphFile, planFile: saved.file }
}

export async function runApply(options = {}) {
  const { home, graph } = await context(options)

  let plan
  if (options.planId) {
    const loaded = await loadPlan(home, options.planId)
    if (!loaded) throw new Error(`plan not found: ${options.planId}`)
    plan = loaded.plan
  } else {
    plan = withMetadata(
      buildPlan(graph, { allowPeerOverride: options.allowPeerOverride }),
      graph,
    )
  }

  if (!options.yes) {
    return { graph, plan, applied: null, needsConfirm: true }
  }

  const saved = await savePlan(home, plan)
  plan.id = saved.plan.id
  const result = await applyPlan({ home, graph, plan })
  await saveGraph(home, graph)
  await writeState(home, {
    profile: graph.profile,
    lastApplied: {
      planId: plan.id,
      at: new Date().toISOString(),
      actions: result.applied.length,
      backup: result.backup,
    },
  })
  return { graph, plan, ...result, needsConfirm: false }
}

export async function runRollback(options = {}) {
  const home = resolveHome(options.home)
  const result = options.id
    ? await rollbackById(home, options.id)
    : await rollback(home)
  if (options.reinstall && result.backup) {
    result.reinstall = await reinstallDependencies(options)
  }
  return result
}

export async function runReport(options = {}) {
  const home = resolveHome(options.home)
  const file = reportFile(home)
  const report = await readJson(file)
  return { file, exists: report != null, report }
}

export async function runList(options = {}) {
  const home = resolveHome(options.home)
  const profile = resolveProfile(home, options.profile)
  const graph = await loadGraph({
    home,
    ...profile,
    scanPorts: false,
    scanLogs: false,
    scanSources: false,
  })
  return {
    home,
    profile: graph.profile,
    dir: graph.dir,
    bundles: graph.bundleInfo.map((info) => ({
      name: info.name,
      version: info.version,
      hasPatch: Boolean(info.patch),
      patchError: info.patchError ?? null,
      peers: info.peers,
    })),
    conflicts: graph.conflicts.map((conflict) => ({
      type: conflict.resource.type,
      key: conflict.resource.key,
      owners: conflict.owners,
      severity: conflict.severity,
    })),
  }
}

export async function runAudit(options = {}) {
  const home = resolveHome(options.home)
  const file = auditFile(home)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { file, exists: false, entries: [] }
    throw err
  }

  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20
  const entries = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 跳过损坏行，不让审计查询失败。
    }
  }

  return { file, exists: true, entries: entries.slice(-limit).reverse() }
}

export async function runBackups(options = {}) {
  const home = resolveHome(options.home)
  const ids = await listBackups(home)
  return { home, ids }
}

/**
 * 调整 bundle 加载顺序：优先加载的插件会先注册，从而在冲突时保留原名。
 * 只处理 dsh.profile.bundles 里的插件；写入前备份 package.json。
 */
export async function runPrefer(options = {}) {
  const home = resolveHome(options.home)
  const profile = resolveProfile(home, options.profile)
  const pkgFile = profilePackageJson(profile.dir)
  const name = options.plugin ?? options.positional?.[0]
  if (!name) return { ok: false, error: 'Usage: dsh-coexist prefer <plugin>' }

  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(pkgFile, 'utf8'))
  } catch (err) {
    return { ok: false, error: `Cannot read ${pkgFile}: ${err.message}` }
  }

  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(name)) {
    return {
      ok: false,
      profile: profile.profile,
      error: `plugin is not in dsh.profile.bundles: ${name}`,
      order: Array.isArray(bundles) ? bundles : [],
    }
  }

  // 只调整第三方插件段：官方 bundle 和 coexist 本身必须保持在前面。
  let cut = bundles.indexOf('dsh-coexist-plugin')
  if (cut < 0) {
    cut = -1
    while (cut + 1 < bundles.length && bundles[cut + 1].startsWith('@deepseek-ai/')) cut += 1
  }
  const head = bundles.slice(0, cut + 1)
  const tail = bundles.slice(cut + 1)
  if (!tail.includes(name)) {
    return {
      ok: false,
      profile: profile.profile,
      error: `plugin is pinned in front of the reorderable section: ${name}`,
      order: bundles,
    }
  }

  const next = [...head, name, ...tail.filter((item) => item !== name)]
  if (next.join('\n') === bundles.join('\n')) {
    return { ok: true, changed: false, profile: profile.profile, plugin: name, order: next }
  }

  const backup = await createBackup(home, [pkgFile])
  manifest.dsh.profile.bundles = next
  await fs.writeFile(pkgFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  await fs.mkdir(path.dirname(auditFile(home)), { recursive: true })
  await fs.appendFile(
    auditFile(home),
    `${JSON.stringify({
      at: new Date().toISOString(),
      applied: [{ kind: 'prefer-bundle', plugin: name, order: next }],
      backup: backup.dir,
    })}\n`,
  )

  return {
    ok: true,
    changed: true,
    profile: profile.profile,
    plugin: name,
    order: next,
    backup: backup.dir,
  }
}
