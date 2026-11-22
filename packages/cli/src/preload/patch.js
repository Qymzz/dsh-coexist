import { appendFileSync } from 'node:fs'

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

export function installPrototypePatch(ToolsService, options = {}) {
  const watch = Array.isArray(options.watch) ? options.watch.filter(Boolean) : []
  const auto = options.auto !== false && watch.length === 0
  const scopeOf = options.scopeOf
  const log = options.log ?? createLog(options.logFile)

  if (!ToolsService || typeof ToolsService.prototype?.register !== 'function') {
    log('[coexist] ToolsService.register not found; prototype patch skipped')
    return false
  }

  if (globalThis.__dshCoexistPrototypePatched) {
    return true
  }

  const watchSet = new Set(watch)
  const states = new Map()
  let aliasCount = 0
  const originalRegister = ToolsService.prototype.register

  function scopeKey(ctx) {
    try {
      const scope = scopeOf ? scopeOf(ctx) : undefined
      return scope ?? 'global'
    } catch {
      return 'global'
    }
  }

  function stateFor(ctx) {
    const key = scopeKey(ctx)
    let state = states.get(key)
    if (!state) {
      state = { entries: new Map(), used: new Set() }
      states.set(key, state)
    }
    return state
  }

  function sameDefinition(left, right) {
    if (left === right) return true
    if (!left || !right) return false
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

  function makeAlias(name, used) {
    let index = 0
    let alias
    do {
      index += 1
      alias = `${name}__coexist${index}`
    } while (used.has(alias))
    return alias
  }

  ToolsService.prototype.register = function registerWithAliases(definition, registerOptions) {
    const name = definition?.name
    if (!name || name === 'run_code') {
      return originalRegister.call(this, definition, registerOptions)
    }
    if (!auto && !watchSet.has(name)) {
      return originalRegister.call(this, definition, registerOptions)
    }

    const state = stateFor(this.ctx)
    const entries = state.entries.get(name)

    if (!entries || entries.length === 0) {
      const dispose = originalRegister.call(this, definition, registerOptions)
      state.entries.set(name, [{ alias: name, definition, dispose }])
      state.used.add(name)
      return dispose
    }

    const primary = entries[0]
    if (sameDefinition(primary.definition, definition)) {
      return () => {}
    }

    const alias = makeAlias(name, state.used)
    const aliasDefinition = { ...definition, name: alias }
    if (definition.description) {
      aliasDefinition.description = `${definition.description} (coexist alias)`
    }

    try {
      const dispose = originalRegister.call(this, aliasDefinition, registerOptions)
      const entry = { alias, definition, dispose }
      entries.push(entry)
      state.used.add(alias)
      aliasCount += 1
      log(`[coexist] alias ${name} -> ${alias}`)
      return () => {
        const current = state.entries.get(name) ?? []
        state.entries.set(name, current.filter((item) => item !== entry))
        state.used.delete(alias)
        dispose()
      }
    } catch (err) {
      log(`[coexist] alias failed for ${name}: ${err.message}`)
      return originalRegister.call(this, definition, registerOptions)
    }
  }

  globalThis.__dshCoexistPrototypePatched = true
  log(`[coexist] preload active (${auto ? 'auto' : `watch=${[...watchSet].join(',')}`})`)

  if (auto) {
    const timer = setTimeout(() => {
      log(
        aliasCount > 0
          ? `[coexist] 已保留 ${aliasCount} 个同名工具，无需操作。`
          : '[coexist] 未发现需要共存的同名工具。',
      )
    }, 5000)
    timer.unref?.()
  }

  return true
}
