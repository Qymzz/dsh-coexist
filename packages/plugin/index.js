import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installPrototypePatch } from './src/patch.js'
import { installToolAliasing } from './src/aliasing.js'
import { installCommandPatch } from './src/commands.js'
import { installProviderPatch } from './src/providers.js'
import { installToolObservation, installToolPolicies } from './src/toolpolicy.js'
import { createDiagnostics, defaultReportFile } from './src/diagnostics.js'
import { loadCoexistConfig, loadRuntimePlan } from './src/config.js'
import { installUiRoutes } from './src/ui.js'
import { installUninstallCleanup } from './src/cleanup.js'

const logFile =
  process.env.DSH_COEXIST_LOG ??
  path.join(os.homedir(), '.dsh', 'coexist', 'plugin.log')

function log(message) {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true })
    appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // Logging must never break the host.
  }
  console.log(message)
}

function currentService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  } catch {
    return undefined
  }
}

function resolveMode(config = {}) {
  const value = config.mode ?? process.env.DSH_COEXIST_MODE ?? 'alias'
  if (value === 'fallback' || value === 'route') return value
  return 'alias'
}

let cachedConfig = null

function currentConfig() {
  if (!cachedConfig) cachedConfig = loadCoexistConfig()
  return cachedConfig
}

function activateTools(ctx, service, source, diagnostics, config) {
  const coexist = currentConfig()
  const capabilities = globalThis.__dshCoexistCapabilities ?? {}
  Object.assign(capabilities, {
    tools: true,
    toolsRegister: typeof service?.register === 'function',
    toolsGuard: typeof service?.guard === 'function',
    schemas: typeof service?.schemas === 'function',
    get: typeof service?.get === 'function',
  })
  globalThis.__dshCoexistCapabilities = capabilities

  const ToolService = service ? Object.getPrototypeOf(service)?.constructor : null
  const installed = installPrototypePatch(ToolService, {
    auto: true,
    mode: resolveMode(config),
    routes: coexist.value.routes,
    logFile,
    onAlias: (name, alias) => globalThis.__dshCoexistRuntime?.onAlias?.(name, alias),
    onCall: (event) => globalThis.__dshCoexistRuntime?.onAliasCall?.(event),
    onFallback: (event) => globalThis.__dshCoexistRuntime?.onFallback?.(event),
    onRoute: (event) => globalThis.__dshCoexistRuntime?.onRoute?.(event),
  })
  if (!installed) return false

  log(`[coexist] prototype patch active (${source}: ${ToolService?.name ?? 'unknown'})`)

  const policy = installToolPolicies(service, {
    policies: coexist.value.toolPolicies,
    log,
  })
  if (policy.installed) {
    try {
      ctx.effect?.(() => () => {
        if (globalThis.__dshCoexistToolPolicyDispose === policy.dispose) {
          policy.dispose?.()
          delete globalThis.__dshCoexistToolPolicyDispose
        }
      })
    } catch {
      // 没有 effect API 时保留进程级状态。
    }
  }

  const observation = installToolObservation(ctx, {
    enabled: coexist.value.observeTools !== false,
    log,
    onCall: (event) => globalThis.__dshCoexistRuntime?.onToolCall?.(event),
  })
  if (observation.installed) {
    try {
      ctx.effect?.(() => () => {
        if (globalThis.__dshCoexistToolObservationDispose === observation.dispose) {
          observation.dispose?.()
          delete globalThis.__dshCoexistToolObservationDispose
        }
      })
    } catch {
      // 没有 effect API 时保留进程级状态。
    }
  }

  return true
}

function activateCommands(service, source) {
  const capabilities = globalThis.__dshCoexistCapabilities ?? {}
  capabilities.commands = true
  globalThis.__dshCoexistCapabilities = capabilities

  const CommandService = service ? Object.getPrototypeOf(service)?.constructor : null
  const installed = installCommandPatch(CommandService, {
    log,
    onAlias: (event) => globalThis.__dshCoexistRuntime?.onCommandAlias?.(event),
  })
  if (installed) log(`[coexist] command patch active (${source})`)
  return installed
}

function activateProviders(service, source) {
  const capabilities = globalThis.__dshCoexistCapabilities ?? {}
  capabilities.providers = true
  globalThis.__dshCoexistCapabilities = capabilities

  const LlmService = service ? Object.getPrototypeOf(service)?.constructor : null
  const installed = installProviderPatch(LlmService, {
    log,
    onAlias: (event) => globalThis.__dshCoexistRuntime?.onProviderAlias?.(event),
    onConflict: (event) => globalThis.__dshCoexistRuntime?.onProviderConflict?.(event),
  })
  if (installed) log(`[coexist] provider patch active (${source})`)
  return installed
}

function resolveServiceBridge(config = {}) {
  return config.serviceBridge === true || process.env.DSH_COEXIST_SERVICE_BRIDGE === '1'
}

function resolveServiceIsolate(config = {}) {
  return config.serviceIsolate === true || process.env.DSH_COEXIST_SERVICE_ISOLATE === '1'
}

function ensureDiagnostics(ctx, config, extras = {}) {
  const previous = globalThis.__dshCoexistDiagnostics
  if (previous && typeof previous.dispose === 'function') {
    previous.dispose()
  }

  globalThis.__dshCoexistCapabilities = {}
  const coexist = currentConfig()
  const diagnostics = createDiagnostics(ctx, {
    log,
    mode: resolveMode(config),
    serviceBridge: resolveServiceBridge(config),
    serviceIsolate: resolveServiceIsolate(config),
    servicePolicies: coexist.value.services,
    serviceMerge: coexist.value.serviceMerge,
    recover: coexist.value.recover === true,
    hooks: coexist.value.hooks,
    plan: extras.plan ?? null,
  })
  globalThis.__dshCoexistDiagnostics = diagnostics
  log(`[coexist] diagnostics report -> ${defaultReportFile()}`)
  if (coexist.exists) log(`[coexist] config loaded from ${coexist.file}`)
  return diagnostics
}

export const name = 'coexist'

// 不声明 inject：需要在 tools/commands/llm 服务刚提供、其他插件 apply 之前就装上 patch。
// 若服务已存在则立即 patch；否则等 internal/service 事件，事件是同步派发的，
// 仍早于所有 inject 插件的 apply。
export function apply(ctx, config = {}) {
  const runtime = loadRuntimePlan()
  const planSummary = runtime.plan
    ? {
        id: runtime.plan.id ?? null,
        createdAt: runtime.plan.createdAt ?? null,
        actions: Array.isArray(runtime.plan.actions) ? runtime.plan.actions.length : 0,
        applied: runtime.state?.lastApplied ?? null,
      }
    : null
  if (planSummary) {
    log(`[coexist] runtime plan loaded: ${planSummary.id} (${planSummary.actions} actions)`)
  }

  const diagnostics = ensureDiagnostics(ctx, config, { plan: planSummary })

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (globalThis.__dshCoexistDiagnostics === diagnostics) {
          diagnostics.dispose()
          delete globalThis.__dshCoexistDiagnostics
        }
      })
    }
  } catch {
    // 没有 effect API 时至少保留进程级清理。
  }

  const installed = { tools: false, commands: false, providers: false }
  const toolsWasPatched = globalThis.__dshCoexistPrototypePatched === true

  const tryInstall = (serviceName, service, source) => {
    if (!service) return false

    if (serviceName === 'tools') {
      if (installed.tools) return true
      if (activateTools(ctx, service, source, diagnostics, config)) {
        installed.tools = true
        return true
      }
      if (!toolsWasPatched) {
        installToolAliasing(ctx, config)
        installed.tools = true
      }
      return installed.tools
    }

    if (serviceName === 'commands') {
      if (installed.commands) return true
      installed.commands = activateCommands(service, source)
      return installed.commands
    }

    if (serviceName === 'llm') {
      if (installed.providers) return true
      installed.providers = activateProviders(service, source)
      return installed.providers
    }

    return false
  }

  tryInstall('tools', currentService(ctx, 'tools'), 'tools service')
  tryInstall('commands', currentService(ctx, 'commands'), 'commands service')
  tryInstall('llm', currentService(ctx, 'llm'), 'llm service')

  try {
    installUiRoutes(ctx, { ...config, log })
  } catch (error) {
    log(`[coexist] ui routes unavailable: ${error.message}`)
  }

  try {
    installUninstallCleanup(ctx, { ...config, log })
  } catch (error) {
    log(`[coexist] host uninstall cleanup unavailable: ${error.message}`)
  }

  if (!installed.tools) log('[coexist] waiting for tools/commands/llm service')

  return ctx.on('internal/service', (serviceName, service) => {
    if (serviceName !== 'tools' && serviceName !== 'commands' && serviceName !== 'llm') return
    if (!service) return
    tryInstall(serviceName, service, 'internal/service')
  })
}
