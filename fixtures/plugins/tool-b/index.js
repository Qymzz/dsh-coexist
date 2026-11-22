console.log('[fixture-tool-b] module loaded')

export const name = 'fixture-tool-b'
export const inject = ['tools']

export function apply(ctx) {
  console.log('[fixture-tool-b] apply start')
  ctx.tools.register({
    name: 'memory_search',
    description: 'fixture B memory search',
    parameters: {
      q: { type: 'string', required: true, description: 'query' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return 'result from fixture B'
    },
  })

  console.log('[fixture-tool-b] registered memory_search')
}
