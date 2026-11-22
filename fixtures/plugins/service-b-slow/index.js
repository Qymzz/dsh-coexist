export const name = 'fixture-service-b-slow'

export function apply(ctx) {
  setTimeout(() => {
    try {
      ctx.provide('demoShared', { beta: () => 'B' })
      const service = ctx.get?.('demoShared')
      console.log(
        `[fixture-service-b-slow] provided; own beta=${service?.beta?.()} alpha=${service?.alpha?.()}`,
      )
    } catch (error) {
      console.log(`[fixture-service-b-slow] failed: ${error.message}`)
    }
  }, 2000)
}
