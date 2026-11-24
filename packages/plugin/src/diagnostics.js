import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function defaultReportFile() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return (
    process.env.DSH_COEXIST_REPORT ??
    path.join(home, 'coexist', 'report.json')
  )
}

function fiberName(fiber) {
  try {
    return typeof fiber?.name === 'string' ? fiber.name : null
  } catch {
    return null
  }
}

function runtimeSink() {
  return globalThis.__dshCoexistRuntime
}

function coexistActive() {
  return globalThis.__dshCoexistActive !== false
}

/** 把失败原因归类，便于 report/CLI 用人话区分。 */
export function classifyFailure(message) {
  const text = String(message ?? '')
  if (!text) return 'runtime'
  if (/must declare output|must declare.*schema|must be a function|timeoutMs|JsonSchema|invalid tool|invalid plugin/i.test(text)) {
    return 'contract'
  }
  if (/service ".*" has been registered|is reserved|requires a scoped context/i.test(text)) {
    return 'service'
  }
  if (/peer|ERESOLVE|Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(text)) {
    return 'dependency'
  }
  return 'runtime'
}

/** 最近 N 次耗时的 p 分位；样本为空时返回 0。 */
export function percentile(values, p) {
  const list = Array.isArray(values) ? values.filter((value) => Number.isFinite(value)) : []
  if (list.length === 0) return 0
  const sorted = [...list].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return Math.round(sorted[index])
}

function summarizeToolStat(stat) {
  const agents = {}
  for (const [agent, data] of Object.entries(stat.agents ?? {})) {
    agents[agent] = {
      calls: data.calls,
      errors: data.errors,
      blocked: data.blocked,
      totalMs: data.totalMs,
      p95: percentile(data.durations, 0.95),
    }
  }
  return {
    calls: stat.calls,
    errors: stat.errors,
    blocked: stat.blocked,
    totalMs: stat.totalMs,
    p95: percentile(stat.durations, 0.95),
    agents,
  }
}

function isServiceConflict(error, name) {
  const message = error?.message
  return (
    typeof message === 'string' &&
    message.includes(`service "${name}"`) &&
    message.includes('has been registered')
  )
}

function findImpl(store, name) {
  if (!store || typeof store !== 'object') return null
  // store 的键是 Symbol（每个 service 一个），Object.values 看不到。
  for (const key of Reflect.ownKeys(store)) {
    const impl = store[key]
    if (impl?.name === name) return impl
  }
  return null
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function collectPlainProps(value) {
  const props = new Map()
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) return null
    const raw = descriptor.value
    props.set(key, typeof raw === 'function' ? raw.bind(value) : raw)
  }
  return props
}

/**
 * 有限 service 代理：双方都必须是普通对象；访问器和类实例一律拒绝。
 * 同名成员默认拒绝，除非显式选择 overlap='first' 或 'last'（不做语义合并）。
 */
export function bridgeServiceValues(base, additions, options = {}) {
  const overlap =
    options.overlap === 'last' ? 'last' : options.overlap === 'first' ? 'first' : 'reject'
  if (!isPlainRecord(base)) return null

  const baseProps = collectPlainProps(base)
  if (!baseProps) return null

  const merged = {}
  const used = new Set()
  for (const [key, value] of baseProps) {
    merged[key] = value
    used.add(key)
  }

  for (const addition of additions) {
    if (!isPlainRecord(addition)) return null
    const props = collectPlainProps(addition)
    if (!props) return null
    for (const [key, value] of props) {
      if (used.has(key)) {
        if (overlap === 'reject') return null
        if (overlap === 'first') continue
      }
      used.add(key)
      merged[key] = value
    }
  }

  return merged
}

/**
 * 包住 ReflectService.provide：
 * - 默认只记录 service 冲突，然后原样上抛；
 * - serviceBridge=true 时，若双方都是属性不重叠的普通对象，则合并成一个代理，
 *   第二个插件不再失败。其他情况仍然上抛。
 */
export function installServiceProbe(ctx, options = {}) {
  if (globalThis.__dshCoexistServiceProbeInstalled) return false

  let reflect
  try {
    reflect = ctx.reflect
  } catch {
    return false
  }
  if (!reflect) return false

  const ReflectService = Object.getPrototypeOf(reflect)?.constructor
  if (!ReflectService || typeof ReflectService.prototype?.provide !== 'function') {
    return false
  }

  const bridges = new Map()
  let bridgeSequence = 0

  const servicePolicies =
    options.servicePolicies && typeof options.servicePolicies === 'object'
      ? options.servicePolicies
      : {}
  const serviceMerge =
    options.serviceMerge && typeof options.serviceMerge === 'object'
      ? options.serviceMerge
      : {}

  const strategyFor = (name) => {
    const entry = servicePolicies[name]
    const strategy = typeof entry === 'string' ? entry : entry?.strategy
    return strategy === 'bridge' || strategy === 'isolate' || strategy === 'block'
      ? strategy
      : null
  }
  const allowBridge = (name) =>
    strategyFor(name) === 'bridge' ||
    (strategyFor(name) === null && options.serviceBridge === true)
  const allowIsolate = (name) =>
    strategyFor(name) === 'isolate' ||
    (strategyFor(name) === null && options.serviceIsolate === true)
  const overlapFor = (name) =>
    serviceMerge[name]?.overlap === 'first' || serviceMerge[name]?.overlap === 'last'
      ? serviceMerge[name].overlap
      : 'reject'

  const notifyConflict = (conflict) => {
    try {
      options.onConflict?.(conflict)
    } catch {
      // 诊断回调不能影响宿主。
    }
    try {
      runtimeSink()?.onServiceConflict?.(conflict)
    } catch {
      // 诊断回调不能影响宿主。
    }
  }

  const original = ReflectService.prototype.provide

  ReflectService.prototype.provide = function provideWithProbe(name, value, check) {
    if (!coexistActive()) return original.call(this, name, value, check)

    try {
      return original.call(this, name, value, check)
    } catch (error) {
      try {
        if (isServiceConflict(error, name)) {
          const existing = findImpl(this.store, name)
          const incomingOwner = fiberName(this.ctx?.fiber)
          const existingOwner = fiberName(existing?.ctx?.fiber ?? existing?.fiber)

          if (allowBridge(name) && existing) {
            let record = bridges.get(name)
            if (!record) {
              record = { impl: existing, original: existing.value, layers: new Map() }
              bridges.set(name, record)
            }

            const merged = bridgeServiceValues(
              record.original,
              [...record.layers.values(), value],
              { overlap: overlapFor(name) },
            )

            if (merged) {
              bridgeSequence += 1
              const layerKey = `${incomingOwner ?? 'unknown'}#${bridgeSequence}`
              record.layers.set(layerKey, value)
              record.impl.value = merged
              notifyConflict({
                service: name,
                existing: existingOwner,
                incoming: incomingOwner,
                message: error.message,
                resolution: 'bridged',
              })
              options.log?.(
                `[coexist] service bridged: ${name} (${existingOwner ?? '?'} + ${incomingOwner ?? '?'})`,
              )
              let cleaned = false
              const cleanup = () => {
                if (cleaned) return
                cleaned = true
                record.layers.delete(layerKey)
                const rebuilt = bridgeServiceValues(
                  record.original,
                  [...record.layers.values()],
                  { overlap: overlapFor(name) },
                )
                record.impl.value = rebuilt ?? record.original
              }

              try {
                this.ctx?.fiber?.effect?.(() => cleanup)
              } catch {
                // 没有 fiber.effect 时至少返回 disposer。
              }
              return cleanup
            }
          }

          if (allowIsolate(name) && existing) {
            const isolateSymbol = Symbol.for('cordis.isolate')
            const ownerContext = this.ctx
            const previousMap = ownerContext?.[isolateSymbol]

            try {
              const nextMap = Object.create(previousMap ?? null)
              nextMap[name] = Symbol(`coexist:${name}:${incomingOwner ?? 'plugin'}`)
              ownerContext[isolateSymbol] = nextMap
              options.log?.(
                `[coexist] service isolate attempt: ${name} for ${incomingOwner ?? '?'} (own=${Object.hasOwn(ownerContext ?? {}, isolateSymbol)})`,
              )

              const isolateDispose = original.call(this, name, value, check)
              notifyConflict({
                service: name,
                existing: existingOwner,
                incoming: incomingOwner,
                message: error.message,
                resolution: 'isolated',
              })
              options.log?.(
                `[coexist] service isolated: ${name} for ${incomingOwner ?? '?'}`,
              )
              return isolateDispose
            } catch (retryError) {
              try {
                ownerContext[isolateSymbol] = previousMap
              } catch {
                // 恢复失败时保持原样，继续按 blocked 处理。
              }
              options.log?.(`[coexist] service isolate failed: ${retryError.message}`)
            }
          }

          notifyConflict({
            service: name,
            existing: existingOwner,
            incoming: incomingOwner,
            message: error.message,
            resolution: 'blocked',
            suggestion: `在 config.json 设置 services["${name}"].strategy 为 "bridge" 或 "isolate"，或停用其中一个插件`,
          })
        }
      } catch {
        // 诊断本身永远不能影响宿主。
      }
      throw error
    }
  }

  globalThis.__dshCoexistServiceProbeInstalled = true
  options.log?.(
    `[coexist] service probe active (${ReflectService.name}, bridge=${options.serviceBridge === true}, isolate=${options.serviceIsolate === true}, policies=${Object.keys(servicePolicies).length})`,
  )
  return true
}

/**
 * 插件 apply 可能早于 coexist 的 apply，那一次 provide 冲突不会经过探针。
 * 但失败 fiber 的错误消息里带着双方名字，可以直接还原。
 */
export function deriveServiceConflicts(failures) {
  const conflicts = []
  for (const failure of failures ?? []) {
    const match = /service "(.+?)" has been registered at <(.+?)>/.exec(failure?.error ?? '')
    if (!match) continue
    conflicts.push({
      service: match[1],
      existing: match[2],
      incoming: failure.plugin ?? null,
      message: failure.error,
    })
  }
  return conflicts
}

function mergeServiceConflicts(primary, derived) {
  const merged = [...primary]
  for (const conflict of derived) {
    const duplicate = merged.some(
      (item) =>
        item.service === conflict.service &&
        item.existing === conflict.existing &&
        item.incoming === conflict.incoming,
    )
    if (!duplicate) merged.push(conflict)
  }
  return merged
}

function missingServices(fiber) {
  const inject = fiber?.inject && typeof fiber.inject === 'object' ? fiber.inject : null
  if (!inject) return []
  const store = fiber?._store && typeof fiber._store === 'object' ? fiber._store : {}
  return Object.keys(inject).filter((name) => !store[name])
}

function failureSuggestion(kind, plugin, message) {
  if (kind === 'service') {
    return `在 config.json 设置 services 策略（bridge/isolate），或停用 ${plugin} 与其冲突的一方`
  }
  if (kind === 'dependency') {
    return '对齐依赖版本，或使用 dsh-coexist apply --allow-peer-override 写入受控 override'
  }
  if (kind === 'contract') {
    return '插件与当前 DSH 契约不兼容；运行 dsh-coexist matrix 检查版本，或停用该插件'
  }
  return message ? '查看 report.json 中的完整错误并对照宿主日志' : null
}

/** 扫描所有 fiber：失败（state 3）和卡住（state 0/1）的插件。 */
export function scanFibers(ctx) {
  const failures = []
  const pending = []
  const seenFailures = new Set()
  const seenPending = new Map()

  let registry
  try {
    registry = ctx.registry
  } catch {
    return { failures, pending }
  }
  if (!registry || typeof registry.values !== 'function') {
    return { failures, pending }
  }

  for (const runtime of registry.values()) {
    const fibers = runtime?.fibers ?? []
    for (const fiber of fibers) {
      if (!fiber || fiber.uid === 0 || fiber.uid == null) continue
      const plugin = fiberName(fiber)
      if (!plugin) continue

      if (fiber.state === 3) {
        if (seenFailures.has(plugin)) continue
        seenFailures.add(plugin)
        const kind = classifyFailure(fiber._error?.message)
        failures.push({
          plugin,
          state: 'failed',
          kind,
          error: fiber._error?.message ?? null,
          suggestion: failureSuggestion(kind, plugin, fiber._error?.message),
        })
        continue
      }

      if (fiber.state === 0 || fiber.state === 1) {
        const missing = missingServices(fiber)
        const existing = seenPending.get(plugin)
        if (existing) {
          for (const name of missing) {
            if (!existing.missing.includes(name)) existing.missing.push(name)
          }
          continue
        }
        const entry = {
          plugin,
          state: fiber.state === 1 ? 'loading' : 'pending',
          missing,
          suggestion:
            missing.length > 0
              ? `安装/启用提供 ${missing.join(', ')} 的 bundle，或给该插件配置 services 策略`
              : null,
        }
        seenPending.set(plugin, entry)
        pending.push(entry)
      }
    }
  }

  return { failures, pending }
}

const HOOK_RISK = [
  {
    re: /^tools\/pre-execute$/,
    risk: 'high',
    reason: '多个门禁监听器都可能拒绝调用，后注册者可能改变最终结果',
  },
  {
    re: /^tools\/post-execute$/,
    risk: 'high',
    reason: '多个监听器都可能改写 content/value，后注册者可能覆盖前面的处理',
  },
  {
    re: /^agent\/pre-step$/,
    risk: 'high',
    reason: '多个监听器都可能注入上下文或修改消息，容易重复注入',
  },
  {
    re: /^(agent\/turn-stopping|agent\/request-error|session\/event)$/,
    risk: 'medium',
    reason: '多个监听器会按注册顺序全部执行，行为可能叠加',
  },
]

function hookRisk(event, listeners, prepend) {
  const rule = HOOK_RISK.find((item) => item.re.test(event))
  if (rule) {
    return { risk: rule.risk, reason: rule.reason }
  }
  if (prepend > 0) {
    return { risk: 'medium', reason: '存在 prepend 监听器，顺序与注册顺序相反' }
  }
  if (listeners > 3) {
    return { risk: 'medium', reason: `${listeners} 个监听器共享同一事件，行为可能叠加` }
  }
  return { risk: 'low', reason: null }
}

/** 列出被多个插件监听的公开事件，并给出风险等级与配置建议。 */
export function scanEventHooks(ctx) {
  let hooks
  try {
    hooks = ctx.events?._hooks
  } catch {
    return []
  }
  if (!hooks || typeof hooks !== 'object') return []

  const result = []
  for (const [event, list] of Object.entries(hooks)) {
    if (event.startsWith('internal/')) continue
    if (!Array.isArray(list) || list.length === 0) continue

    const owners = [
      ...new Set(
        list
          .map((hook) => fiberName(hook?.ctx?.fiber))
          .filter((owner) => owner && owner !== 'coexist'),
      ),
    ]
    if (owners.length < 2) continue

    const prepend = list.filter((hook) => hook?.prepend === true).length
    const judgement = hookRisk(event, list.length, prepend)
    result.push({
      event,
      owners,
      listeners: list.length,
      prepend,
      risk: judgement.risk,
      reason: judgement.reason,
      suggestion: `hooks["${event}"].order / disable`,
    })
  }

  return result
}

function hookOwner(hook) {
  return fiberName(hook?.ctx?.fiber)
}

/**
 * 按配置对指定事件的监听器做排序/禁用：
 * hooks: { "agent/pre-step": { order: ["plugin-a"], disable: ["plugin-b"] } }
 * 只影响列出的公开事件；没有配置时不安装。
 */
export function installHookPolicy(ctx, options = {}) {
  if (globalThis.__dshCoexistHookPolicyInstalled) return false

  let events
  try {
    events = ctx.events
  } catch {
    return false
  }
  const EventsService = events ? Object.getPrototypeOf(events)?.constructor : null
  if (!EventsService || typeof EventsService.prototype?.dispatch !== 'function') {
    return false
  }

  if (options.hooks && typeof options.hooks === 'object') {
    globalThis.__dshCoexistHookPolicies = options.hooks
  }

  const original = EventsService.prototype.dispatch

  EventsService.prototype.dispatch = function dispatchWithHookPolicy(type, args) {
    const policies = globalThis.__dshCoexistHookPolicies ?? {}
    const name =
      typeof args[0] === 'object' || typeof args[0] === 'function' ? args[1] : args[0]
    const policy = policies[name]
    const hooks = this._hooks?.[name]

    if (!policy || !Array.isArray(hooks)) return original.call(this, type, args)

    const current = hooks.slice()
    let next = current

    if (Array.isArray(policy.disable) && policy.disable.length > 0) {
      const disabled = new Set(policy.disable)
      next = next.filter((hook) => !disabled.has(hookOwner(hook)))
    }

    if (Array.isArray(policy.order) && policy.order.length > 0) {
      const rank = new Map(policy.order.map((owner, index) => [owner, index]))
      next = [...next].sort((left, right) => {
        const leftRank = rank.has(hookOwner(left))
          ? rank.get(hookOwner(left))
          : Number.MAX_SAFE_INTEGER
        const rightRank = rank.has(hookOwner(right))
          ? rank.get(hookOwner(right))
          : Number.MAX_SAFE_INTEGER
        return leftRank - rightRank
      })
    }

    if (next.length === current.length && next.every((hook, index) => hook === current[index])) {
      return original.call(this, type, args)
    }

    this._hooks[name] = next
    try {
      return original.call(this, type, args)
    } finally {
      this._hooks[name] = current
    }
  }

  globalThis.__dshCoexistHookPolicyInstalled = true
  const initial = options.hooks && typeof options.hooks === 'object' ? Object.keys(options.hooks) : []
  if (initial.length > 0) {
    options.log?.(`[coexist] hook policy active (${initial.join(', ')})`)
  }
  return true
}

/**
 * 创建运行期诊断：service 冲突、失败/卡住的插件、多插件监听的事件。
 * 报告写入 $DSH_HOME/coexist/report.json，默认启动 8 秒后写一次。
 */
export function createDiagnostics(ctx, options = {}) {
  const log = options.log ?? (() => {})
  const reportFile = options.reportFile ?? defaultReportFile()
  const delayMs = Number(options.delayMs ?? process.env.DSH_COEXIST_REPORT_DELAY_MS ?? 8000)
  const mode =
    options.mode === 'fallback' ? 'fallback' : options.mode === 'route' ? 'route' : 'alias'
  const serviceBridge = options.serviceBridge === true
  const serviceIsolate = options.serviceIsolate === true

  const state = {
    aliases: [],
    fallbacks: [],
    routes: [],
    routeLogged: new Set(),
    serviceConflicts: [],
    commandAliases: [],
    providerAliases: [],
    providerConflicts: [],
    toolCalls: [],
    toolStats: {},
    recoveries: [],
  }

  let timer = null
  let initialTimer = null

  const write = () => {
    try {
      const scan = scanFibers(ctx)
      const serviceConflicts = mergeServiceConflicts(
        state.serviceConflicts,
        deriveServiceConflicts(scan.failures),
      )
      const report = {
        generatedAt: new Date().toISOString(),
        pid: process.pid,
        mode,
        tools: {
          aliases: state.aliases,
          fallbacks: state.fallbacks,
          routes: state.routes,
          calls: state.toolCalls,
          stats: Object.fromEntries(
            Object.entries(state.toolStats).map(([tool, stat]) => [tool, summarizeToolStat(stat)]),
          ),
          slowCalls: [...state.toolCalls]
            .sort((left, right) => right.durationMs - left.durationMs)
            .slice(0, 10),
        },
        commands: { aliases: state.commandAliases },
        providers: { aliases: state.providerAliases, conflicts: state.providerConflicts },
        plan: options.plan ?? null,
        capabilities: { ...(globalThis.__dshCoexistCapabilities ?? {}) },
        recoveries: state.recoveries,
        serviceConflicts,
        failures: scan.failures,
        pending: scan.pending,
        eventHooks: scanEventHooks(ctx),
      }

      mkdirSync(path.dirname(reportFile), { recursive: true })
      writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`)
      log(
        `[coexist] report: aliases=${report.tools.aliases.length} fallbacks=${report.tools.fallbacks.length} routes=${report.tools.routes.length} commandAliases=${report.commands.aliases.length} providerAliases=${report.providers.aliases.length} providerConflicts=${report.providers.conflicts.length} serviceConflicts=${report.serviceConflicts.length} failures=${report.failures.length} pending=${report.pending.length} eventHooks=${report.eventHooks.length} -> ${reportFile}`,
      )
    } catch (error) {
      log(`[coexist] report failed: ${error.message}`)
    }
  }

  const schedule = (delay = 2000) => {
    if (timer || !reportFile) return
    timer = setTimeout(() => {
      timer = null
      write()
    }, delay)
    timer.unref?.()
  }

  const recordServiceConflict = (conflict) => {
    const duplicate = state.serviceConflicts.some(
      (item) =>
        item.service === conflict.service &&
        item.existing === conflict.existing &&
        item.incoming === conflict.incoming &&
        item.resolution === conflict.resolution,
    )
    if (duplicate) return
    state.serviceConflicts.push(conflict)
    log(
      `[coexist] service conflict: "${conflict.service}" already owned by ${conflict.existing ?? 'unknown'}, ${
        conflict.resolution === 'bridged'
          ? 'bridged with'
          : conflict.resolution === 'isolated'
            ? 'isolated for'
            : 'rejected'
      } ${conflict.incoming ?? 'unknown'}`,
    )
    schedule()
  }

  const recordAlias = (name, alias) => {
    if (state.aliases.some((item) => item.name === name && item.alias === alias)) return
    state.aliases.push({ name, alias })
    schedule()
  }

  const recordAliasCall = (event) => {
    const entry = state.aliases.find((item) => item.alias === event?.tool)
    if (!entry) return
    entry.calls = (entry.calls ?? 0) + 1
    if (entry.calls === 1) {
      log(`[coexist] alias call: ${entry.alias} (for ${entry.name})`)
    }
    schedule()
  }

  const recordFallback = (event) => {
    state.fallbacks.push({
      tool: event?.tool ?? null,
      error: event?.error ?? null,
      at: new Date().toISOString(),
    })
    if (state.fallbacks.length > 50) state.fallbacks.shift()
    log(`[coexist] fallback: ${event?.tool ?? 'unknown'} -> backup (${event?.error ?? ''})`)
    schedule()
  }

  const recordRoute = (event) => {
    const entry = {
      tool: event?.tool ?? null,
      target: event?.target ?? null,
      reason: event?.reason ?? null,
      at: new Date().toISOString(),
    }
    state.routes.push(entry)
    if (state.routes.length > 50) state.routes.shift()

    const key = `${entry.tool}:${entry.target}`
    if (!state.routeLogged.has(key)) {
      state.routeLogged.add(key)
      log(`[coexist] route: ${entry.tool} -> ${entry.target} (${entry.reason ?? 'rule'})`)
    }
    schedule()
  }

  const recordCommandAlias = (event) => {
    if (!event?.name || !event?.alias) return
    if (state.commandAliases.some((item) => item.name === event.name && item.alias === event.alias)) {
      return
    }
    state.commandAliases.push({ name: event.name, alias: event.alias })
    log(`[coexist] command alias recorded: /${event.name} -> /${event.alias}`)
    schedule()
  }

  const recordProviderAlias = (event) => {
    if (!event?.name || !event?.alias) return
    if (state.providerAliases.some((item) => item.name === event.name && item.alias === event.alias)) {
      return
    }
    state.providerAliases.push({ name: event.name, alias: event.alias })
    log(`[coexist] provider alias recorded: ${event.name} -> ${event.alias}`)
    schedule()
  }

  const recordProviderConflict = (event) => {
    if (!event?.name) return
    const duplicate = state.providerConflicts.some(
      (item) => item.name === event.name && item.message === event.message,
    )
    if (duplicate) return
    state.providerConflicts.push({
      name: event.name,
      message: event.message ?? null,
      code: event.code ?? null,
      resolution: event.resolution ?? 'blocked',
    })
    log(`[coexist] provider conflict: "${event.name}" (${event.resolution ?? 'blocked'})`)
    schedule()
  }

  const recordToolCall = (event) => {
    if (!event?.tool) return
    const tool = String(event.tool)
    const durationMs = Number(event.durationMs ?? 0)
    const agent = event.agent == null ? 'unknown' : String(event.agent)
    const stat =
      state.toolStats[tool] ??
      { calls: 0, errors: 0, blocked: 0, totalMs: 0, durations: [], agents: {} }
    stat.calls += 1
    stat.totalMs += durationMs
    if (event.error) stat.errors += 1
    if (event.blocked) stat.blocked += 1
    stat.durations ??= []
    stat.durations.push(durationMs)
    if (stat.durations.length > 200) stat.durations.shift()

    const agentStat =
      stat.agents?.[agent] ??
      { calls: 0, errors: 0, blocked: 0, totalMs: 0, durations: [] }
    agentStat.calls += 1
    agentStat.totalMs += durationMs
    if (event.error) agentStat.errors += 1
    if (event.blocked) agentStat.blocked += 1
    agentStat.durations ??= []
    agentStat.durations.push(durationMs)
    if (agentStat.durations.length > 100) agentStat.durations.shift()
    stat.agents ??= {}
    stat.agents[agent] = agentStat
    state.toolStats[tool] = stat

    state.toolCalls.push({
      tool,
      agent: event.agent ?? null,
      durationMs,
      blocked: event.blocked === true,
      error: event.error ?? null,
      at: new Date().toISOString(),
    })
    if (state.toolCalls.length > 50) state.toolCalls.shift()
    schedule()
  }

  const recoverAttempted = new Set()

  /**
   * 可选：对失败的 fiber 各重试一次（opt-in，避免无限循环）。
   * service 隔离/合并开启时，自动重试 service 冲突失败的插件：
   * 插件并发加载时，冲突可能发生在探针安装之前，重试让隔离策略有机会生效。
   */
  const recoverNow = async () => {
    const autoServiceRecover =
      serviceBridge ||
      serviceIsolate ||
      Object.keys(options.servicePolicies ?? {}).length > 0
    if (options.recover !== true && !autoServiceRecover) return []
    let registry
    try {
      registry = ctx.registry
    } catch {
      return []
    }
    if (!registry || typeof registry.values !== 'function') return []

    const retried = []
    for (const runtime of registry.values()) {
      for (const fiber of [...(runtime?.fibers ?? [])]) {
        if (!fiber || fiber.state !== 3) continue
        const plugin = fiberName(fiber)
        if (!plugin || recoverAttempted.has(plugin)) continue
        if (
          options.recover !== true &&
          !/service ".*" has been registered/.test(fiber._error?.message ?? '')
        ) {
          continue
        }

        recoverAttempted.add(plugin)
        try {
          // 启动失败后 fiber 已不再运行。释放它让 loader 重新初始化同一条 entry：
          // 此时探针已装好，冲突会按 serviceBridge / serviceIsolate 策略处理。
          // 没有 dispose 的宿主退化到 restart()。
          if (fiber.uid !== null && fiber.uid !== 0 && typeof fiber.dispose === 'function') {
            await fiber.dispose()
          } else if (typeof fiber.restart === 'function') {
            const result = fiber.restart()
            if (result && typeof result.then === 'function') {
              result.then(() => schedule(2000), () => schedule(2000))
            }
          }
          state.recoveries.push({
            plugin,
            state: 'restarted',
            at: new Date().toISOString(),
          })
          retried.push(plugin)
          log(`[coexist] restarted failed plugin: ${plugin}`)
        } catch (error) {
          state.recoveries.push({
            plugin,
            state: 'retry-failed',
            error: error?.message ?? String(error),
            at: new Date().toISOString(),
          })
        }
      }
    }
    if (retried.length > 0) schedule()
    return retried
  }

  const sink = {
    onAlias: recordAlias,
    onAliasCall: recordAliasCall,
    onFallback: recordFallback,
    onRoute: recordRoute,
    onServiceConflict: recordServiceConflict,
    onCommandAlias: recordCommandAlias,
    onProviderAlias: recordProviderAlias,
    onProviderConflict: recordProviderConflict,
    onToolCall: recordToolCall,
  }

  const hookPolicies =
    options.hooks && typeof options.hooks === 'object' ? options.hooks : {}

  globalThis.__dshCoexistActive = true
  globalThis.__dshCoexistRuntime = sink
  globalThis.__dshCoexistHookPolicies = hookPolicies

  installServiceProbe(ctx, { log, serviceBridge, serviceIsolate })

  try {
    ctx.on('internal/status', () => schedule(2000))
  } catch {
    // 事件服务不可用时只保留定时报告。
  }

  installHookPolicy(ctx, { hooks: hookPolicies, log })

  initialTimer = setTimeout(async () => {
    write()
    await recoverNow()
  }, Math.max(1000, delayMs))
  initialTimer.unref?.()

  return {
    reportFile,
    write,
    recordAlias,
    recordAliasCall,
    recordFallback,
    recordRoute,
    recordCommandAlias,
    recordProviderAlias,
    recordProviderConflict,
    recordToolCall,
    recoverNow,
    dispose() {
      if (timer) clearTimeout(timer)
      if (initialTimer) clearTimeout(initialTimer)
      timer = null
      initialTimer = null

      if (globalThis.__dshCoexistRuntime === sink) {
        delete globalThis.__dshCoexistRuntime
        globalThis.__dshCoexistActive = false
      }
      if (globalThis.__dshCoexistHookPolicies === hookPolicies) {
        delete globalThis.__dshCoexistHookPolicies
      }
      delete globalThis.__dshCoexistCapabilities
    },
  }
}
