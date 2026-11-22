import net from 'node:net'
import { compareVersions, minVersionForRange, satisfies } from './semver.js'

const HOST_PEER_PREFIXES = ['@deepseek-ai/']
const PORT_KEY_RE = /^ports?$/i

/**
 * insert 行之间撞同一个 loader entry id。
 * 来自第三方 bundle 的行仍然报告，但是否可自动改名由 plan 判断。
 */
export function detectLoaderEntryConflicts(rows) {
  const inserts = rows.filter((row) => row.op === 'insert' || row.op === 'row')
  const byId = new Map()

  for (const row of inserts) {
    if (typeof row.id !== 'string') continue
    const list = byId.get(row.id) ?? []
    list.push(row)
    byId.set(row.id, list)
  }

  const conflicts = []
  for (const [key, entries] of byId) {
    if (entries.length < 2) continue
    // 同 id 同包名的 profile 行是对 bundle 行的覆盖，不是冲突。
    const names = new Set(entries.map((row) => row.name ?? `<${row.source}>`))
    if (names.size === 1) continue
    conflicts.push({
      resource: { type: 'loader-entry', key },
      owners: entries.map((row) => row.name ?? `<${row.source}>`),
      rows: entries.map((row) => ({
        file: row.file,
        source: row.source,
        op: row.op,
        name: row.name ?? null,
        config: row.config,
        disabled: row.disabled,
      })),
      strategies: ['rename-entry', 'merge-row'],
      recommended: 'rename-entry',
      severity: 'conflict',
    })
  }
  return conflicts
}

function sourceLabel(row) {
  return row.name ?? `<${row.source}>`
}

/**
 * patch 层覆盖分析：以“最终生效行”为准。
 * - 只有 replace、没有 insert → dangling；
 * - 最终行没有保留前层的 disabled: true → 冲突；
 * - 最终行清空 config → 冲突；
 * - 最终行丢掉部分 config 键 → info。
 * 每条冲突带 suggestedPatch，供 plan 生成补全行。
 */
export function detectPatchOverrides(rows) {
  const byId = new Map()
  for (const row of rows) {
    if (typeof row.id !== 'string') continue
    const list = byId.get(row.id) ?? []
    list.push(row)
    byId.set(row.id, list)
  }

  const conflicts = []

  for (const [id, entries] of byId) {
    const final = entries[entries.length - 1]
    const inserts = entries.filter((row) => row.op === 'insert' || row.op === 'row')

    if (inserts.length === 0) {
      conflicts.push({
        resource: { type: 'patch-dangling-replace', key: id },
        owners: [sourceLabel(final)],
        detail: `replace 的目标 "${id}" 在所有 patch 层里都没有 insert`,
        rows: [{ file: final.file, source: final.source, op: final.op, name: final.name ?? null }],
        strategies: ['fix-id', 'change-to-insert'],
        recommended: 'manual',
        severity: 'conflict',
      })
      continue
    }

    if (entries.length < 2) continue

    const disabledWanted = entries.some((row) => row.disabled === true)
    const disabledLost = disabledWanted && final.disabled === undefined

    const earlierConfig = {}
    for (const row of entries.slice(0, -1)) {
      Object.assign(earlierConfig, asObject(row.config) ?? {})
    }
    const finalConfig = asObject(final.config)
    const finalKeys = finalConfig ? Object.keys(finalConfig) : []
    const missingKeys = Object.keys(earlierConfig).filter((key) => !finalKeys.includes(key))
    const configWiped = Object.keys(earlierConfig).length > 0 && finalKeys.length === 0

    if (!disabledLost && !configWiped && missingKeys.length === 0) continue

    const mergedConfig = { ...earlierConfig, ...(finalConfig ?? {}) }
    const suggestedPatch = {
      id,
      name: final.name ?? entries[0].name ?? null,
      config: mergedConfig,
    }
    if (disabledWanted) suggestedPatch.disabled = true

    conflicts.push({
      resource: { type: 'patch-override', key: id },
      owners: [sourceLabel(entries[0]), sourceLabel(final)],
      detail: [
        disabledLost ? '最终生效行没有保留前层的 disabled: true' : null,
        configWiped ? '最终生效行清空了 config' : null,
        !configWiped && missingKeys.length > 0
          ? `最终生效行丢失 config 键: ${missingKeys.join(', ')}`
          : null,
      ]
        .filter(Boolean)
        .join('；'),
      rows: entries.map((row) => ({
        file: row.file,
        source: row.source,
        op: row.op,
        name: row.name ?? null,
        config: row.config,
        disabled: row.disabled,
      })),
      strategies: ['write-full-config', 'reorder-layers'],
      recommended: 'manual',
      severity: disabledLost || configWiped ? 'conflict' : 'info',
      suggestedPatch,
    })
  }

  return conflicts
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function isPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535
}

function portsIn(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return []

  const ports = []
  for (const [key, entry] of Object.entries(value)) {
    if (PORT_KEY_RE.test(key)) {
      if (isPort(entry)) ports.push(entry)
      else if (Array.isArray(entry)) {
        for (const item of entry) if (isPort(item)) ports.push(item)
      } else if (typeof entry === 'string' && /^\d+$/.test(entry) && isPort(Number(entry))) {
        ports.push(Number(entry))
      }
      continue
    }
    if (entry && typeof entry === 'object') ports.push(...portsIn(entry, depth + 1))
  }
  return ports
}

/** 从 patch 行的 config 里收集显式声明的端口。 */
export function collectDeclaredPorts(rows) {
  const found = new Map()

  for (const row of rows) {
    const config = asObject(row.config)
    if (!config) continue
    for (const port of portsIn(config)) {
      const list = found.get(port) ?? []
      list.push({
        owner: sourceLabel(row),
        file: row.file,
        source: row.source,
        id: row.id ?? null,
        name: row.name ?? null,
      })
      found.set(port, list)
    }
  }

  return found
}

/** 尝试绑定端口；EADDRINUSE 视为被占用，其它错误不阻止启动前扫描。 */
export function defaultProbePort(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (busy) => {
      if (settled) return
      settled = true
      server.close(() => resolve(busy))
      setTimeout(() => resolve(busy), 50).unref?.()
    }

    const server = net.createServer()
    server.once('error', (error) => finish(error.code === 'EADDRINUSE'))
    server.once('listening', () => finish(false))
    server.listen({ port, host, exclusive: true })
    setTimeout(() => finish(false), timeoutMs).unref?.()
  })
}

export function detectPortConflicts(rows, options = {}) {
  const declared = collectDeclaredPorts(rows)
  const busyPorts = options.busyPorts ?? new Set()
  const conflicts = []

  for (const [port, owners] of declared) {
    if (owners.length > 1) {
      conflicts.push({
        resource: { type: 'port', key: String(port) },
        owners: [...new Set(owners.map((owner) => owner.owner))],
        detail: busyPorts.has(port)
          ? `端口 ${port} 已被占用，且被多个插件声明`
          : `多个插件都声明了端口 ${port}`,
        rows: owners.map((owner) => ({
          file: owner.file,
          source: owner.source,
          id: owner.id,
          name: owner.name,
        })),
        strategies: ['change-port'],
        recommended: 'manual',
        severity: 'conflict',
      })
      continue
    }

    if (busyPorts.has(port)) {
      conflicts.push({
        resource: { type: 'port', key: String(port) },
        owners: [owners[0].owner, '其它进程'],
        detail: `端口 ${port} 已被其它进程占用`,
        rows: [
          {
            file: owners[0].file,
            source: owners[0].source,
            id: owners[0].id,
            name: owners[0].name,
          },
        ],
        strategies: ['change-port', 'stop-process'],
        recommended: 'manual',
        severity: 'conflict',
      })
    }
  }

  return conflicts
}

/**
 * peer 版本比对。bundles 里每项形如：
 * { name, version, peers: [{ name, range, installed }] }
 * 未安装的 @deepseek-ai/* 视为宿主提供，跳过；其它未安装依赖报告出来。
 */
export function detectPeerConflicts(bundles) {
  const groups = new Map()

  for (const bundle of bundles) {
    for (const peer of bundle.peers ?? []) {
      const list = groups.get(peer.name) ?? []
      list.push({ bundle, peer })
      groups.set(peer.name, list)
    }
  }

  const conflicts = []

  for (const [dep, entries] of groups) {
    const installed = entries.find((entry) => entry.peer.installed)?.peer.installed ?? null
    const unsatisfied = entries.filter(
      (entry) => entry.peer.installed && !satisfies(entry.peer.installed, entry.peer.range),
    )
    const missing = entries.filter(
      (entry) =>
        !entry.peer.installed &&
        !HOST_PEER_PREFIXES.some((prefix) => dep.startsWith(prefix)),
    )

    if (unsatisfied.length > 0) {
      const suggestedVersion =
        unsatisfied
          .map((entry) => minVersionForRange(entry.peer.range))
          .filter(Boolean)
          .sort((left, right) => compareVersions(right, left))[0] ?? null

      conflicts.push({
        resource: { type: 'peer', key: dep },
        owners: [...new Set(unsatisfied.map((entry) => entry.bundle.name))],
        detail: [
          ...unsatisfied.map((entry) => `${entry.bundle.name} 需要 ${entry.peer.range}`),
          `已安装 ${installed}`,
        ].join('；'),
        peers: entries.map((entry) => ({
          bundle: entry.bundle.name,
          range: entry.peer.range,
          installed: entry.peer.installed ?? null,
        })),
        suggestedVersion,
        strategies: ['report-only', 'upgrade', 'downgrade', 'peer-override'],
        recommended: 'manual',
        severity: 'conflict',
      })
      continue
    }

    if (missing.length > 0) {
      const suggestedVersion =
        missing
          .map((entry) => minVersionForRange(entry.peer.range))
          .filter(Boolean)
          .sort((left, right) => compareVersions(right, left))[0] ?? null

      conflicts.push({
        resource: { type: 'peer', key: dep },
        owners: [...new Set(missing.map((entry) => entry.bundle.name))],
        detail: [
          ...missing.map((entry) => `${entry.bundle.name} 需要 ${entry.peer.range}`),
          '未安装',
        ].join('；'),
        peers: missing.map((entry) => ({
          bundle: entry.bundle.name,
          range: entry.peer.range,
          installed: null,
        })),
        suggestedVersion,
        strategies: ['report-only', 'install', 'peer-override'],
        recommended: 'manual',
        severity: 'conflict',
      })
    }
  }

  return conflicts
}

/** 同一个 bundle 在 profile 的 bundles 列表里出现多次。 */
export function detectDuplicateBundles(bundles) {
  const counts = new Map()
  for (const bundle of bundles) {
    counts.set(bundle, (counts.get(bundle) ?? 0) + 1)
  }

  const conflicts = []
  for (const [key, count] of counts) {
    if (count <= 1) continue
    conflicts.push({
      resource: { type: 'bundle', key },
      owners: bundles.filter((bundle) => bundle === key),
      strategies: ['dedupe'],
      recommended: 'dedupe',
      severity: 'conflict',
    })
  }
  return conflicts
}

export function detectAllConflicts({ rows, bundles, bundleInfo, busyPorts }) {
  return [
    ...detectDuplicateBundles(bundles ?? []),
    ...detectLoaderEntryConflicts(rows),
    ...detectPatchOverrides(rows),
    ...detectPeerConflicts(bundleInfo ?? []),
    ...detectPortConflicts(rows, { busyPorts }),
  ]
}
