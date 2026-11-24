import path from 'node:path'
import { readJson, readPatch } from './load.js'
import { profilePackageJson, profilePatch, homePatch } from './paths.js'
import {
  collectDeclaredPorts,
  defaultProbePort,
  detectAllConflicts,
} from './detectors.js'
import { detectSourceConflicts, scanBundleSources } from './sourcescan.js'
import { scanLogs } from './logscan.js'

async function resolveInstalledVersion(profileDir, bundleDir, dep) {
  for (const base of [profileDir, bundleDir]) {
    const pkg = await readJson(
      path.join(base, 'node_modules', ...dep.split('/'), 'package.json'),
    )
    if (pkg?.version) return pkg.version
  }
  return null
}

async function loadBundleInfo({ name, profileDir }) {
  const bundleDir = path.join(profileDir, 'node_modules', ...name.split('/'))
  const pkg = await readJson(path.join(bundleDir, 'package.json'))
  const info = {
    name,
    dir: bundleDir,
    version: pkg?.version ?? null,
    patchFile: null,
    patch: null,
    peers: [],
  }

  if (!pkg) return info

  const patchRel = pkg?.dsh?.bundle?.patch
  if (typeof patchRel === 'string') {
    const patchFile = path.resolve(bundleDir, patchRel)
    info.patchFile = patchFile
    try {
      const patch = await readPatch(patchFile)
      if (patch.exists) info.patch = patch
    } catch (error) {
      // 第三方 patch 可能含 !!js 等自定义标签；解析失败只跳过该 bundle，不能让 check 崩掉。
      info.patchError = error.message
    }
  }

  const peerDependencies =
    pkg.peerDependencies && typeof pkg.peerDependencies === 'object'
      ? pkg.peerDependencies
      : {}
  const dependencies =
    pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  info.dependencies = dependencies

  for (const [dep, range] of Object.entries(peerDependencies)) {
    info.peers.push({
      name: dep,
      range: String(range),
      installed: await resolveInstalledVersion(profileDir, bundleDir, dep),
    })
  }

  return info
}

/**
 * 在已加载的 bundle 之间找循环依赖；只把同时是 bundle 的依赖/peer 当作边。
 * 返回的每个环只出现一次（按旋转归一化）。
 */
export function detectDependencyCycles(bundles) {
  const names = new Set((bundles ?? []).map((bundle) => bundle.name))
  const edges = new Map()
  for (const bundle of bundles ?? []) {
    const deps = new Set([
      ...Object.keys(bundle.dependencies ?? {}),
      ...(bundle.peers ?? []).map((peer) => peer.name),
    ])
    edges.set(bundle.name, [...deps].filter((dep) => names.has(dep)))
  }

  const cycles = []
  const seen = new Set()
  const visiting = new Set()
  const visited = new Set()
  const stack = []

  const visit = (name) => {
    if (visiting.has(name)) {
      const start = stack.indexOf(name)
      const cycle = stack.slice(start)
      const rotations = cycle.map((_, index) =>
        [...cycle.slice(index), ...cycle.slice(0, index)].join('>'),
      )
      const canonical = rotations.sort()[0]
      if (!seen.has(canonical)) {
        seen.add(canonical)
        cycles.push(cycle)
      }
      return
    }
    if (visited.has(name)) return
    visiting.add(name)
    stack.push(name)
    for (const dep of edges.get(name) ?? []) visit(dep)
    stack.pop()
    visiting.delete(name)
    visited.add(name)
  }

  for (const name of names) visit(name)
  return cycles
}

async function probeBusyPorts(rows, probePort) {
  const declared = collectDeclaredPorts(rows)
  const ports = [...declared.keys()].slice(0, 32)
  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        return [port, await probePort(port)]
      } catch {
        return [port, false]
      }
    }),
  )
  return new Set(results.filter(([, busy]) => busy).map(([port]) => port))
}

export async function loadGraph({
  home,
  profile,
  dir,
  probePort = defaultProbePort,
  scanPorts = true,
  scanLogs: scanLogFiles = true,
  scanSources = true,
  logFile,
}) {
  const packageJsonPath = profilePackageJson(dir)
  const packageJson = await readJson(packageJsonPath)

  const bundles = Array.isArray(packageJson?.dsh?.profile?.bundles)
    ? packageJson.dsh.profile.bundles
    : []

  // bundle 自身的 patch 是更早的层；同一 bundle 重复出现只扫描一次，
  // 重复本身由 bundle 冲突单独报告。
  const layers = []
  const bundleInfo = []
  for (const name of [...new Set(bundles)]) {
    const info = await loadBundleInfo({ name, profileDir: dir })
    bundleInfo.push(info)
    if (info.patch) layers.push({ ...info.patch, source: `bundle:${name}` })
  }

  const profilePatchData = await readPatch(profilePatch(dir))
  if (profilePatchData.exists) {
    layers.push({ ...profilePatchData, source: 'profile' })
  }
  const homePatchData = await readPatch(homePatch(home))
  if (homePatchData.exists) {
    layers.push({ ...homePatchData, source: 'home' })
  }

  const rows = []
  for (const layer of layers) {
    for (const row of layer.rows) {
      rows.push({ ...row, file: layer.file, source: layer.source })
    }
  }

  const busyPorts = scanPorts ? await probeBusyPorts(rows, probePort) : new Set()
  const sourceConflicts = scanSources
    ? detectSourceConflicts(await scanBundleSources(bundleInfo))
    : []
  const conflicts = [
    ...detectAllConflicts({ rows, bundles, bundleInfo, busyPorts }),
    ...sourceConflicts,
  ]
  const logResult = scanLogFiles
    ? await scanLogs({ home, logFile })
    : { file: logFile ?? null, issues: [] }

  return {
    home,
    profile,
    dir,
    packageJsonPath,
    packageJson,
    bundles,
    bundleInfo,
    patches: layers,
    rows,
    busyPorts: [...busyPorts],
    conflicts,
    cycles: detectDependencyCycles(bundleInfo),
    logFile: logResult.file,
    logIssues: logResult.issues,
  }
}
