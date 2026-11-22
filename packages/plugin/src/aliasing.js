const RESERVED_TOOL_NAMES = new Set(['run_code'])
const DEFAULT_MAX_ALIAS_LENGTH = 64

function normalizeConfig(config = {}) {
  const envWatch = (process.env.DSH_COEXIST_WATCH ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const watch = Array.isArray(config.watch) && config.watch.length > 0 ? config.watch : envWatch
  const ignore = new Set([...(config.ignore ?? []), ...RESERVED_TOOL_NAMES])
  return {
    mode: config.mode ?? 'alias',
    watch,
    ignore,
    prefix: config.prefix ?? 'coexist',
    maxAliasLength: config.maxAliasLength ?? DEFAULT_MAX_ALIAS_LENGTH,
    debug: config.debug === true,
  }
}

function matchesWatch(name, watch) {
  return watch.includes('*') || watch.includes(name)
}

function sanitize(value) {
  return String(value)
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function cloneWithName(def, name) {
  const description = def.description
    ? `${def.description} (coexist alias)`
    : 'coexist alias for a duplicate tool name'
  return { ...def, name, description }
}

function log(ctx, level, message, extra) {
  const logger = ctx?.logger
  const fn = logger?.[level]
  if (typeof fn === 'function') {
    fn.call(logger, message, extra)
    return
  }
  if (level === 'warn' || level === 'error') {
    console.warn(message, extra ?? '')
  }
}

/**
 * 包装 ctx.tools.register：同名工具不再抛错，而是注册成一个稳定的别名，
 * 避免第二个插件因为重名而整块加载失败。
 *
 * @param {object} ctx Cordis 上下文（或带 tools/effect/logger 的测试替身）。
 * @param {object} config
 * @param {'alias'|'off'} [config.mode='alias'] 共存模式；当前只支持 alias。
 * @param {string[]} [config.watch=[]] 要接管的工具名；为空时不启用共存。
 * @param {string[]} [config.ignore=[]] 保持原生行为的工具名。
 * @param {string} [config.prefix='coexist'] 别名后缀前缀。
 * @param {number} [config.maxAliasLength=64] 别名最大长度（DeepSeek 工具名限制）。
 */
export function installToolAliasing(ctx, config = {}) {
  const options = normalizeConfig(config)
  const tools = ctx?.tools

  if (!tools || typeof tools.register !== 'function') {
    return { installed: false, reason: 'ctx.tools.register is not available' }
  }
  if (options.watch.length === 0) {
    return { installed: false, reason: 'watch list is empty; coexistence disabled' }
  }
  if (options.mode === 'off') {
    return { installed: false, reason: 'mode=off' }
  }
  if (options.mode !== 'alias') {
    return { installed: false, reason: `unsupported mode: ${options.mode}` }
  }

  const originalRegister = tools.register.bind(tools)
  const registry = new Map()
  let sequence = 0

  const makeAlias = (name) => {
    const base = sanitize(name) || 'tool'
    for (;;) {
      sequence += 1
      const suffix = `__${options.prefix}${sequence}`
      const room = Math.max(1, options.maxAliasLength - suffix.length)
      const alias = `${base.slice(0, room)}${suffix}`
      if (!registry.has(alias) && alias !== name) return alias
    }
  }

  const wrappedRegister = (def) => {
    const toolName = def?.name
    if (typeof toolName !== 'string' || toolName.length === 0) {
      return originalRegister(def)
    }
    if (options.ignore.has(toolName) || !matchesWatch(toolName, options.watch)) {
      return originalRegister(def)
    }

    const entries = registry.get(toolName)

    if (!entries || entries.length === 0) {
      const dispose = originalRegister(def)
      const entry = { name: toolName, alias: toolName, def, dispose, primary: true }
      registry.set(toolName, [entry])
      return () => {
        const current = registry.get(toolName) ?? []
        const next = current.filter((item) => item !== entry)
        if (next.length === 0) registry.delete(toolName)
        else registry.set(toolName, next)
        entry.dispose()
      }
    }

    let alias
    try {
      alias = makeAlias(toolName)
      const aliasDef = cloneWithName(def, alias)
      const dispose = originalRegister(aliasDef)
      const entry = { name: toolName, alias, def, dispose, primary: false }
      entries.push(entry)
      registry.set(toolName, entries)
      log(ctx, 'info', `[coexist] "${toolName}" already registered; mounted alias "${alias}"`)
      return () => {
        const current = registry.get(toolName) ?? []
        const next = current.filter((item) => item !== entry)
        if (next.length === 0) registry.delete(toolName)
        else registry.set(toolName, next)
        entry.dispose()
      }
    } catch (err) {
      // fail-open：保留宿主的原生行为。第二个插件可能仍然失败，
      // 但兼容层不能把事情变得更糟。
      log(ctx, 'warn', `[coexist] alias registration failed for "${toolName}"; falling back to native behavior`, err)
      return originalRegister(def)
    }
  }

  let patched = false
  try {
    tools.register = wrappedRegister
    patched = tools.register === wrappedRegister
  } catch {
    patched = false
  }

  if (!patched) {
    try {
      Object.defineProperty(tools, 'register', {
        configurable: true,
        writable: true,
        value: wrappedRegister,
      })
      patched = tools.register === wrappedRegister
    } catch {
      patched = false
    }
  }

  if (!patched) {
    if (options.debug) {
      try {
        const proto = Object.getPrototypeOf(tools)
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'register') : undefined
        log(ctx, 'warn', `[coexist] diagnostics: ${JSON.stringify({
          extensible: Object.isExtensible(tools),
          frozen: Object.isFrozen(tools),
          protoFrozen: proto ? Object.isFrozen(proto) : null,
          descriptor: descriptor
            ? { writable: descriptor.writable, configurable: descriptor.configurable }
            : null,
        })}`)
        console.log('[coexist] diagnostics', JSON.stringify({
          extensible: Object.isExtensible(tools),
          frozen: Object.isFrozen(tools),
          protoFrozen: proto ? Object.isFrozen(proto) : null,
          descriptor: descriptor
            ? { writable: descriptor.writable, configurable: descriptor.configurable }
            : null,
        }))
      } catch (err) {
        log(ctx, 'warn', `[coexist] diagnostics failed: ${err.message}`)
      }
    }
    log(ctx, 'warn', '[coexist] ctx.tools.register is not writable; coexistence disabled for this session')
    return { installed: false, reason: 'ctx.tools.register is not writable' }
  }

  const restore = () => {
    try {
      tools.register = originalRegister
    } catch {
      // 服务可能在启动后被冻结；此时没有别的清理动作可做。
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => restore)
  }

  log(ctx, 'info', `[coexist] duplicate tool aliasing enabled (watch=${options.watch.join(',')})`)

  return {
    installed: true,
    registry,
    restore,
    originalRegister,
    wrappedRegister,
  }
}
