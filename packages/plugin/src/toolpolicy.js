function agentId(exec) {
  const agent = exec?.agent
  if (!agent) return null
  const candidate = agent.session?.id ?? agent.id ?? agent.name ?? agent.preset
  return candidate == null ? null : String(candidate)
}

function ruleFor(policies, name) {
  if (!policies || typeof policies !== 'object') return null
  if (typeof name === 'string' && policies[name] && typeof policies[name] === 'object') {
    return { name, rule: policies[name] }
  }
  if (policies['*'] && typeof policies['*'] === 'object') {
    return { name: '*', rule: policies['*'] }
  }
  return null
}

function evaluateRule(rule, exec) {
  const agent = agentId(exec)
  const agents = rule.agents ?? {}

  if (Array.isArray(rule.denyAgents) && agent && rule.denyAgents.includes(agent)) {
    return rule.reason ?? `agent "${agent}" is denied for tool "${exec?.name}"`
  }
  if (Array.isArray(agents.deny) && agent && agents.deny.includes(agent)) {
    return rule.reason ?? `agent "${agent}" is denied for tool "${exec?.name}"`
  }
  if (Array.isArray(rule.allowAgents) && rule.allowAgents.length > 0) {
    if (!agent || !rule.allowAgents.includes(agent)) {
      return rule.reason ?? `agent "${agent ?? 'unknown'}" is not allowed to call tool "${exec?.name}"`
    }
  }
  if (Array.isArray(agents.allow) && agents.allow.length > 0) {
    if (!agent || !agents.allow.includes(agent)) {
      return rule.reason ?? `agent "${agent ?? 'unknown'}" is not allowed to call tool "${exec?.name}"`
    }
  }
  if (rule.deny === true) {
    return typeof rule.reason === 'string' && rule.reason.length > 0
      ? rule.reason
      : `tool "${exec?.name}" is disabled by coexist policy`
  }
  if (typeof rule.deny === 'string' && rule.deny.length > 0) {
    return rule.deny
  }
  return undefined
}

/**
 * 用 tools.guard() 注册一个同步门禁。guard 是单调拒绝：任何匹配规则返回字符串即拒绝，
 * 不会覆盖别的插件已经做出的放行决定。
 * 配置：toolPolicies: { "memory_search": { deny: true|"原因", allowAgents: [...], denyAgents: [...] } }
 */
export function installToolPolicies(service, options = {}) {
  if (!service || typeof service.guard !== 'function') {
    return { installed: false, dispose: null }
  }

  const policies = options.policies && typeof options.policies === 'object' ? options.policies : {}
  if (Object.keys(policies).length === 0) {
    return { installed: false, dispose: null }
  }

  const previous = globalThis.__dshCoexistToolPolicyDispose
  if (typeof previous === 'function') {
    try {
      previous()
    } catch {
      // 旧 guard 已被宿主清理时忽略。
    }
  }

  let dispose
  try {
    dispose = service.guard((exec) => {
      const matched = ruleFor(policies, exec?.name)
      if (!matched) return undefined
      const reason = evaluateRule(matched.rule, exec)
      if (reason !== undefined) {
        options.log?.(`[coexist] tool policy denied: ${exec?.name} (${reason})`)
      }
      return reason
    })
  } catch {
    return { installed: false, dispose: null }
  }

  globalThis.__dshCoexistToolPolicyDispose = typeof dispose === 'function' ? dispose : null
  options.log?.(
    `[coexist] tool policy active (${Object.keys(policies).length} rule${Object.keys(policies).length === 1 ? '' : 's'})`,
  )
  return { installed: true, dispose: typeof dispose === 'function' ? dispose : null }
}

/**
 * 观察 tools/post-execute：只记录调用、耗时、是否被拒绝，不修改结果。
 * 监听器把 next() 的决定原样返回，保证不改变宿主行为。
 */
export function installToolObservation(ctx, options = {}) {
  if (options.enabled === false) return { installed: false, dispose: null }
  if (!ctx || typeof ctx.on !== 'function') return { installed: false, dispose: null }

  const previous = globalThis.__dshCoexistToolObservationDispose
  if (typeof previous === 'function') {
    try {
      previous()
    } catch {
      // 旧监听器已被宿主清理时忽略。
    }
  }

  let dispose
  try {
    dispose = ctx.on('tools/post-execute', async (exec, result, next) => {
      const started = Date.now()
      try {
        const decision = typeof next === 'function' ? await next() : { kind: 'accept' }
        try {
          options.onCall?.({
            tool: exec?.name ?? null,
            agent: agentId(exec),
            durationMs: Date.now() - started,
            blocked: decision?.kind === 'block',
            isError: result?.isError === true,
          })
        } catch {
          // 观测回调不能影响宿主。
        }
        return decision
      } catch (error) {
        try {
          options.onCall?.({
            tool: exec?.name ?? null,
            agent: agentId(exec),
            durationMs: Date.now() - started,
            error: error?.message ?? String(error),
          })
        } catch {
          // 观测回调不能影响宿主。
        }
        throw error
      }
    })
  } catch {
    return { installed: false, dispose: null }
  }

  globalThis.__dshCoexistToolObservationDispose = typeof dispose === 'function' ? dispose : null
  options.log?.('[coexist] tool observation active (tools/post-execute)')
  return { installed: true, dispose: typeof dispose === 'function' ? dispose : null }
}
