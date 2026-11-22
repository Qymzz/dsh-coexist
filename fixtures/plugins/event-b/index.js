export const name = 'fixture-event-b'

export function apply(ctx) {
  ctx.on('demo/ping', () => {
    console.log('[fixture-event-b] demo/ping handled')
  })
  console.log('[fixture-event-b] listening demo/ping')
}
