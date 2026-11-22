import { appendFileSync } from 'node:fs'

const NAME_LIMIT = 64
const ROUTER = Symbol('coexist.router')

function createLog(logFile) {
  return (message) => {
    if (logFile) {
      try {
        appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`)
      } catch {
        // Logging must never break the host.
      }
    }
    console.log(message)
  }
}

/** 原生 register 只在同作用域重名时抛这个错；其他错误必须原样上抛。 */
function isDuplicateToolError(error, name) {
  const message = error?.message
  return (
    typeof message === 'string' &&
    typeof name === 'string' &&
    message.includes('is already registered') &&
    message.includes(`"${name}"`)
  )
}

function aliasName(name, index) {
  const suffix = `__coexist${index}`
  if (name.length + suffix.length <= NAME_LIMIT) return `${name}${suffix}`
  return `${name.slice(0, NAME_LIMIT - suffix.length)}${suffix}`
}

function sameDefinition(left, right) {
  if (!left || !right) return false
  if (left === right) return true
  if (left.execute !== right.execute) return false
  if (left.description !== right.description) return false
  try {
    return (
      JSON.stringify(left.parameters) === JSON.stringify(right.parameters) &&
      JSON.stringify(left.output?.schema) === JSON.stringify(right.output?.schema)
    )
  } catch {
    return false
  }
}

/**
 * 从运行期的 layers 里找到同名定义（与刚才抛重复错误的作用域一致）。
 * dsh-scope 的 scoped 表是内部结构；任何异常都 fail-open 返回 null。
 */
function findExistingDefinition(runtime, name) {
  const layers = runtime?.layers
  if (!layers) return null

  const lookup = (layer) => {
    try {
      return layer?.tools?.get?.(name) ?? null
    } catch {
      return null
    }
  }

  const globalDefinition = lookup(layers.global)
  if (globalDefinition) return globalDefinition

  const scoped = layers.scoped
  if (scoped && typeof scoped.values === 'function') {
    for (const layer of scoped.values()) {
      const found = lookup(layer)
      if (found) return found
    }
  }

  return null
}

function defineRouter(definition, router) {
  try {
    Object.defineProperty(definition, ROUTER, {
      value: router,
      enumerable: false,
      configurable: true,
    })
  } catch {
    // 冻结的定义对象只影响 fallback/route，不影响别名共存。
  }
}

function chooseRoute(rule, args, exec) {
  if (!rule || typeof rule !== 'object') return null
  const decision = {
    target: rule.prefer === 'primary' ? 'primary' : 'backup',
    index: Number.isInteger(rule.index) && rule.index >= 0 ? rule.index : 0,
  }
  const primary = { target: 'primary', index: 0 }

  if (rule.by === 'agent') {
    const wanted = rule.equals ?? rule.match
    if (wanted == null) return null
    const agent = exec?.agent
    const candidates = [
      agent?.session?.id,
      agent?.id,
      agent?.name,
      agent?.preset,
      agent === undefined ? null : String(agent),
    ]
      .filter((value) => value !== undefined && value !== null)
      .map(String)
    return candidates.includes(String(wanted)) ? decision : primary
  }

  const match = rule.match && typeof rule.match === 'object' ? rule.match : null
  if (!match) return null

  for (const [key, expected] of Object.entries(match)) {
    let actual
    try {
      actual = args?.[key]
    } catch {
      return primary
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return primary
  }

  return decision
}

function runEntry(entry, callArgs) {
  try {
    return entry.execute.apply(entry.definition, callArgs)
  } catch (error) {
    return Promise.reject(error)
  }
}

function wrapForRoute(definition, name, rule, options) {
  const originalExecute = definition.execute
  if (typeof originalExecute !== 'function' || !rule) return definition

  const router = { primaryDefinition: definition, primary: originalExecute, backups: [] }
  const primaryEntry = { definition, execute: originalExecute }

  const routed = { ...definition }
  routed.execute = function executeWithRoute(...callArgs) {
    let target = 'primary'
    let index = 0
    let reason = 'default'

    try {
      const decided = chooseRoute(rule, callArgs[0], callArgs[1])
      if (decided) {
        target = decided.target
        index = decided.index
        reason = rule.by ?? 'rule'
      }
    } catch {
      target = 'primary'
    }

    if (target === 'backup' && router.backups.length > 0) {
      const chosen = router.backups[Math.min(index, router.backups.length - 1)]
      try {
        options.onRoute?.({ tool: name, target: 'backup', reason, index })
      } catch {
        // 诊断回调不能影响调用。
      }
      return runEntry(chosen, callArgs)
    }

    return runEntry(primaryEntry, callArgs)
  }

  defineRouter(routed, router)
  return routed
}

function wrapForFallback(definition, name, options) {
  const originalExecute = definition.execute
  if (typeof originalExecute !== 'function') return definition

  const router = { primaryDefinition: definition, primary: originalExecute, backups: [] }
  const primaryEntry = { definition, execute: originalExecute }

  const routed = { ...definition }
  routed.execute = async function executeWithFallback(...callArgs) {
    try {
      return await runEntry(primaryEntry, callArgs)
    } catch (primaryError) {
      let lastError = primaryError

      for (let index = 0; index < router.backups.length; index += 1) {
        const backup = router.backups[index]
        try {
          const result = await runEntry(backup, callArgs)
          try {
            options.onFallback?.({
              tool: name,
              error: primaryError?.message ?? String(primaryError),
              backup: index,
            })
          } catch {
            // 诊断回调不能影响调用。
          }
          return result
        } catch (error) {
          lastError = error
        }
      }

      throw lastError
    }
  }

  defineRouter(routed, router)
  return routed
}

function wrapForAlias(definition, alias, primaryName, options) {
  const originalExecute = definition.execute
  const aliasDefinition = { ...definition, name: alias }
  if (definition.description) {
    aliasDefinition.description = `${definition.description} (coexist alias)`
  }
  if (typeof originalExecute === 'function') {
    aliasDefinition.execute = function executeAlias(...args) {
      try {
        options.onCall?.({ tool: alias, aliasOf: primaryName })
      } catch {
        // 诊断回调不能影响调用。
      }
      return originalExecute.apply(definition, args)
    }
  }
  return aliasDefinition
}

/**
 * 在 ToolRuntime 原型上包一层 register：
 * 1. 相同定义重复注册 → 忽略（一个名字只保留一个实现）。
 * 2. 不同定义重复注册 → 注册成 `<name>__coexistN`，两个都能调用。
 * 3. mode=fallback 时，主实现抛错后显式降级到备份实现，并记录一次 fallback。
 * 4. mode=route 时，按 routes 规则选择主实现或备份实现。
 *
 * @param {Function} ToolService 宿主注册类（桌面版为 ToolRuntime，CLI 版为 ToolsService）。
 * @param {object} options
 * @param {boolean} [options.auto=true] 自动接管所有工具名；false 时只接管 watch 列表。
 * @param {string[]} [options.watch=[]] 需要接管的工具名。
 * @param {'alias'|'fallback'|'route'} [options.mode='alias'] 重名策略。
 * @param {object} [options.routes] mode=route 时的按工具路由规则。
 * @param {(message: string) => void} [options.log] 日志函数。
 * @param {string} [options.logFile] 日志文件路径。
 * @param {(name: string, alias: string) => void} [options.onAlias] 新别名回调。
 * @param {(event: { tool: string, aliasOf: string }) => void} [options.onCall] 别名被调用回调。
 * @param {(event: { tool: string, error: string }) => void} [options.onFallback] 降级回调。
 * @param {(event: { tool: string, target: string, reason: string }) => void} [options.onRoute] 路由回调。
 */
export function installPrototypePatch(ToolService, options = {}) {
  const watch = Array.isArray(options.watch) ? options.watch.filter(Boolean) : []
  const auto = options.auto !== false && watch.length === 0
  const watchSet = new Set(watch)
  const log = options.log ?? createLog(options.logFile)
  const mode =
    options.mode === 'fallback' ? 'fallback' : options.mode === 'route' ? 'route' : 'alias'
  const fallback = mode === 'fallback'
  const routes = options.routes && typeof options.routes === 'object' ? options.routes : {}

  if (!ToolService || typeof ToolService.prototype?.register !== 'function') {
    log('[coexist] tools register not found; prototype patch skipped')
    return false
  }

  if (globalThis.__dshCoexistPrototypePatched) {
    return true
  }

  const originalRegister = ToolService.prototype.register

  ToolService.prototype.register = function registerWithCoexist(definition, registerOptions) {
    if (globalThis.__dshCoexistActive === false) {
      return originalRegister.call(this, definition, registerOptions)
    }

    const name = definition?.name
    const watched = auto || (typeof name === 'string' && watchSet.has(name))
    if (!watched) {
      return originalRegister.call(this, definition, registerOptions)
    }

    const prepared = fallback
      ? wrapForFallback(definition, name, options)
      : mode === 'route'
        ? wrapForRoute(definition, name, routes[name], options)
        : definition

    try {
      return originalRegister.call(this, prepared, registerOptions)
    } catch (error) {
      if (!isDuplicateToolError(error, name)) throw error

      const existing = findExistingDefinition(this, name)
      const existingOriginal = existing?.[ROUTER]?.primaryDefinition ?? existing

      if (existing && sameDefinition(existingOriginal, definition)) {
        log(`[coexist] identical duplicate ignored: ${name}`)
        return () => {}
      }

      for (let index = 1; index <= 100; index += 1) {
        const alias = aliasName(name, index)
        const aliasDefinition = wrapForAlias(definition, alias, name, options)

        try {
          const disposeAlias = originalRegister.call(this, aliasDefinition, registerOptions)
          const router = existing?.[ROUTER]
          let backupEntry = null

          if (router && typeof definition.execute === 'function') {
            backupEntry = { definition, execute: definition.execute }
            router.backups.push(backupEntry)
          }

          log(`[coexist] alias ${name} -> ${alias}`)
          try {
            options.onAlias?.(name, alias)
          } catch {
            // 诊断回调不能影响注册。
          }

          return () => {
            if (router && backupEntry) {
              const position = router.backups.indexOf(backupEntry)
              if (position !== -1) router.backups.splice(position, 1)
            }
            disposeAlias()
          }
        } catch (aliasError) {
          if (!isDuplicateToolError(aliasError, alias)) throw aliasError
        }
      }

      throw error
    }
  }

  globalThis.__dshCoexistPrototypePatched = true
  log(
    `[coexist] preload active (${auto ? 'auto' : `watch=${[...watchSet].join(',')}`}, mode=${mode})`,
  )
  return true
}
