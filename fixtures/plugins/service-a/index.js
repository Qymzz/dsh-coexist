export const name = 'fixture-service-a'

export function apply(ctx) {
  ctx.provide('demoShared', { alpha: () => 'A' })
  console.log('[fixture-service-a] provided demoShared.alpha')
}
