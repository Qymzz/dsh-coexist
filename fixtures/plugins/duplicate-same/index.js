export const name = 'fixture-duplicate-same'
export const inject = ['tools']

const definition = {
  name: 'same_tool',
  description: 'same tool definition',
  parameters: {},
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  async execute() {
    return 'same'
  },
}

export function apply(ctx) {
  ctx.tools.register(definition)
  ctx.tools.register(definition)
  console.log('[fixture-duplicate-same] registered same_tool twice')
}
