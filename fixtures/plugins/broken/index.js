export const name = 'fixture-broken'

export function apply() {
  throw new Error('fixture broken on purpose')
}
