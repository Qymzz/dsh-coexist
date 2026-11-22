export const name = 'fixture-event-a'

export function apply(ctx) {
  ctx.on('demo/ping', () => {
    console.log('[fixture-event-a] demo/ping handled')
  })
  console.log('[fixture-event-a] listening demo/ping')
}
