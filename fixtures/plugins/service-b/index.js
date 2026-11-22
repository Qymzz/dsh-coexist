export const name = 'fixture-service-b'

export function apply(ctx) {
  ctx.provide('demoShared', { beta: () => 'B' })
  console.log('[fixture-service-b] provided demoShared.beta')
}
