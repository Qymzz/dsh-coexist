export const name = 'fixture-tool-a-fail'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'memory_search',
    description: 'fixture A (fails)',
    parameters: {
      q: { type: 'string', required: true, description: 'query' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      throw new Error('fixture A down')
    },
  })

  console.log('[fixture-tool-a-fail] registered memory_search (failing)')
}
