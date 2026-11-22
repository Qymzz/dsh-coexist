console.log('[fixture-probe] module loaded')

export const name = 'fixture-probe'
export const inject = ['tools']

export function apply(ctx) {
  setTimeout(async () => {
    try {
      const schemas = ctx.tools.schemas?.() ?? []
      console.log(`[fixture-probe] visible tools: ${schemas.map((tool) => tool.name).join(', ')}`)
      const sameToolCount = schemas.filter((tool) => tool.name === 'same_tool').length
      console.log(`[fixture-probe] same_tool count: ${sameToolCount}`)

      try {
        const service = ctx.get?.('demoShared')
        if (service) {
          console.log(
            `[fixture-probe] demoShared keys: ${Object.keys(service).join(',')} alpha=${service.alpha?.()} beta=${service.beta?.()}`,
          )
        } else {
          console.log('[fixture-probe] demoShared not available')
        }
      } catch (err) {
        console.log(`[fixture-probe] demoShared failed: ${err.message}`)
      }
    } catch (err) {
      console.log(`[fixture-probe] schemas failed: ${err.message}`)
    }

    for (const [toolName, args, label] of [
      ['memory_search', { q: 'probe', scope: 'code' }, 'routed'],
      ['memory_search', { q: 'probe', scope: 'chat' }, 'primary'],
      ['memory_search__coexist1', { q: 'probe' }, 'alias'],
    ]) {
      try {
        const result = await ctx.tools.execute({
          callId: `probe-${toolName}-${label}`,
          name: toolName,
          arguments: args,
          signal: AbortSignal.timeout(5000),
        })
        console.log(`[fixture-probe] ${label} ${toolName} -> ${JSON.stringify(result)}`)
      } catch (err) {
        console.log(`[fixture-probe] ${label} ${toolName} failed: ${err.message}`)
      }
    }

    try {
      ctx.emit?.('demo/ping')
      console.log('[fixture-probe] emitted demo/ping')
    } catch (err) {
      console.log(`[fixture-probe] emit failed: ${err.message}`)
    }
  }, 4000)
}
