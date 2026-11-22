const COMMAND_SUFFIX = '__coexist'

function isDuplicateCommandError(error, name) {
  const message = error?.message
  return (
    typeof message === 'string' &&
    typeof name === 'string' &&
    message.includes(`command "${name}" is already registered`)
  )
}

function aliasCommandName(name, index) {
  return `${name}${COMMAND_SUFFIX}${index}`
}

function aliasDescription(description) {
  if (typeof description !== 'string' || description.trim().length === 0) return 'coexist alias'
  return `${description} (coexist alias)`
}

/**
 * 在 CommandRuntime 原型上包一层 register：
 * 同名命令冲突时，把后注册的命令改成 `<name>__coexistN`，两个命令都保留。
 *
 * 命令名规则是 /^[a-z][a-z0-9_-]*$/，下划线合法，因此别名不需要额外转义。
 * 只处理宿主明确抛出的 "command ... is already registered"；其它错误原样上抛。
 */
export function installCommandPatch(CommandService, options = {}) {
  if (!CommandService || typeof CommandService.prototype?.register !== 'function') {
    return false
  }
  if (globalThis.__dshCoexistCommandPatched) return true

  const log = options.log ?? (() => {})
  const original = CommandService.prototype.register

  CommandService.prototype.register = function registerWithCoexist(definition, ...rest) {
    if (globalThis.__dshCoexistActive === false) {
      return original.call(this, definition, ...rest)
    }

    const name = definition?.name
    try {
      return original.call(this, definition, ...rest)
    } catch (error) {
      if (!isDuplicateCommandError(error, name)) throw error

      for (let index = 1; index <= 100; index += 1) {
        const alias = aliasCommandName(name, index)
        const aliasDefinition = {
          ...definition,
          name: alias,
          description: aliasDescription(definition?.description),
        }

        try {
          const dispose = original.call(this, aliasDefinition, ...rest)
          log(`[coexist] command alias: /${name} -> /${alias}`)
          try {
            options.onAlias?.({ name, alias, kind: 'command' })
          } catch {
            // 诊断回调不能影响宿主。
          }
          return dispose
        } catch (retryError) {
          if (isDuplicateCommandError(retryError, alias)) continue
          throw retryError
        }
      }

      throw error
    }
  }

  globalThis.__dshCoexistCommandPatched = true
  log(`[coexist] command patch active (${CommandService.name ?? 'unknown'})`)
  return true
}
