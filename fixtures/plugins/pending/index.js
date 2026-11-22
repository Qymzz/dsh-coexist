export const name = 'fixture-pending'
export const inject = ['missingService']

export function apply() {
  console.log('[fixture-pending] should never run')
}
