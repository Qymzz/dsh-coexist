const PROVIDER_SUFFIX = '__coexist'

function isDuplicateAdapterError(error) {
  if (error?.code === 'DUPLICATE_ADAPTER') return true
  return /an adapter for provider ".*" is already registered/.test(String(error?.message ?? ''))
}

function isDuplicateDirectoryError(error) {
  if (error?.code === 'DUPLICATE_DIRECTORY') return true
  return /configurable provider ".*" is already (declared|registered)/.test(String(error?.message ?? ''))
}

function extractProvider(message) {
  const match = /provider "([^"]+)" is already (?:registered|declared)/.exec(String(message ?? ''))
  return match?.[1] ?? null
}

function aliasProvider(provider, index) {
  return `${provider}${PROVIDER_SUFFIX}${index}`
}

function findFreeAlias(provider, used) {
  for (let index = 1; index <= 100; index += 1) {
    const candidate = aliasProvider(provider, index)
    if (!used.has(candidate)) return candidate
  }
  return null
}

/**
 * 代理 adapter：providerInfo 返回别名 id，其余方法在收到别名时自动换回原 provider。
 * 这样插件自己的 adapter 代码不需要知道别名存在。
 */
function proxyAdapter(adapter, reverse) {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'providerInfo') {
        return (provider) => {
          const original = reverse.get(provider) ?? provider
          const info = target.providerInfo(original)
          return { ...info, id: provider }
        }
      }

      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args) => {
        if (args.length > 0 && typeof args[0] === 'string' && reverse.has(args[0])) {
          args[0] = reverse.get(args[0])
        }
        return value.apply(target, args)
      }
    },
  })
}

function recordAlias(record, options) {
  try {
    options.onAlias?.(record)
  } catch {
    // 诊断回调不能影响宿主。
  }
}

function recordBlocked(record, options) {
  try {
    options.onConflict?.({ ...record, resolution: 'blocked' })
  } catch {
    // 诊断回调不能影响宿主。
  }
}

/**
 * 在 LlmService 原型上包一层 provider 注册：
 * - registerAdapter：provider 已被占用时，把后注册的 route 改成 `<provider>__coexistN`，
 *   并用代理 adapter 在调用时换回原 provider；
 * - registerConfigurableProviders：同样按 provider 别名处理。
 *
 * 别名只在宿主明确抛 DUPLICATE_* 时启用；其它错误原样上抛。
 */
export function installProviderPatch(LlmService, options = {}) {
  if (!LlmService || typeof LlmService.prototype?.registerAdapter !== 'function') {
    return false
  }
  if (globalThis.__dshCoexistProviderPatched) return true

  const log = options.log ?? (() => {})

  const registerAdapter = LlmService.prototype.registerAdapter
  LlmService.prototype.registerAdapter = function registerAdapterWithCoexist(providers, adapter) {
    if (globalThis.__dshCoexistActive === false) {
      return registerAdapter.call(this, providers, adapter)
    }

    let current = Array.isArray(providers) ? [...providers] : providers
    const reverse = new Map()
    let proxied = adapter

    for (let attempt = 0; attempt <= 100; attempt += 1) {
      try {
        const dispose = registerAdapter.call(this, current, proxied)
        for (const [alias, original] of reverse) {
          log(`[coexist] provider alias: ${original} -> ${alias}`)
          recordAlias({ kind: 'provider', name: original, alias }, options)
        }
        return dispose
      } catch (error) {
        if (!isDuplicateAdapterError(error)) {
          if (reverse.size > 0) {
            recordBlocked(
              {
                kind: 'provider',
                name: [...reverse.values()].join(','),
                message: error.message,
                code: error.code ?? null,
              },
              options,
            )
          }
          throw error
        }

        const conflict = extractProvider(error.message)
        if (!conflict || !current.includes(conflict)) {
          recordBlocked(
            { kind: 'provider', name: conflict, message: error.message, code: error.code ?? null },
            options,
          )
          throw error
        }

        const used = new Set([
          ...current,
          ...(this.adapters instanceof Map ? this.adapters.keys() : []),
          ...reverse.keys(),
        ])
        const alias = findFreeAlias(conflict, used)
        if (!alias) {
          recordBlocked(
            { kind: 'provider', name: conflict, message: 'no free alias', code: error.code ?? null },
            options,
          )
          throw error
        }

        reverse.set(alias, conflict)
        current = current.map((provider) => (provider === conflict ? alias : provider))
        proxied = proxyAdapter(adapter, reverse)
      }
    }

    throw new Error('coexist: provider alias attempts exhausted')
  }

  if (typeof LlmService.prototype.registerConfigurableProviders === 'function') {
    const registerConfigurable = LlmService.prototype.registerConfigurableProviders
    LlmService.prototype.registerConfigurableProviders = function registerConfigurableWithCoexist(
      entries,
    ) {
      if (globalThis.__dshCoexistActive === false) {
        return registerConfigurable.call(this, entries)
      }

      let current = Array.isArray(entries) ? [...entries] : entries
      const reverse = new Map()

      for (let attempt = 0; attempt <= 100; attempt += 1) {
        try {
          const dispose = registerConfigurable.call(this, current)
          for (const [alias, original] of reverse) {
            log(`[coexist] provider alias: ${original} -> ${alias}`)
            recordAlias({ kind: 'provider', name: original, alias }, options)
          }
          return dispose
        } catch (error) {
          if (!isDuplicateDirectoryError(error)) {
            if (reverse.size > 0) {
              recordBlocked(
                {
                  kind: 'provider',
                  name: [...reverse.values()].join(','),
                  message: error.message,
                  code: error.code ?? null,
                },
                options,
              )
            }
            throw error
          }

          const conflict = extractProvider(error.message)
          const entry = conflict
            ? current.find((item) => item?.provider === conflict)
            : null
          if (!entry) {
            recordBlocked(
              { kind: 'provider', name: conflict, message: error.message, code: error.code ?? null },
              options,
            )
            throw error
          }

          const used = new Set([
            ...current.map((item) => item?.provider).filter(Boolean),
            ...(this.directory instanceof Map ? this.directory.keys() : []),
            ...reverse.keys(),
          ])
          const alias = findFreeAlias(conflict, used)
          if (!alias) {
            recordBlocked(
              { kind: 'provider', name: conflict, message: 'no free alias', code: error.code ?? null },
              options,
            )
            throw error
          }

          reverse.set(alias, conflict)
          current = current.map((item) =>
            item?.provider === conflict ? { ...item, provider: alias } : item,
          )
        }
      }

      throw new Error('coexist: configurable provider alias attempts exhausted')
    }
  }

  globalThis.__dshCoexistProviderPatched = true
  log(`[coexist] provider patch active (${LlmService.name ?? 'unknown'})`)
  return true
}
