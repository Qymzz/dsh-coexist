console.log('[fixture-tool-a] module loaded')

export const name = 'fixture-tool-a'
export const inject = ['tools']

export function apply(ctx) {
  console.log('[fixture-tool-a] apply start')
  ctx.tools.register({
    name: 'memory_search',
    description: 'fixture A memory search',
    parameters: {
      q: { type: 'string', required: true, description: 'query' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return 'result from fixture A'
    },
  })

  console.log('[fixture-tool-a] registered memory_search')
}
