import { installToolAliasing } from '../src/aliasing.js'

const store = new Map()

const ctx = {
  tools: {
    register(def) {
      if (store.has(def.name)) {
        throw new Error(`duplicate tool name: ${def.name}`)
      }
      store.set(def.name, def)
      return () => store.delete(def.name)
    },
  },
  effect() {},
  logger: {
    info: (message) => console.log(message),
    warn: (message, error) => console.warn(message, error ?? ''),
  },
}

function makeTool(name, result) {
  return {
    name,
    description: `demo ${name}`,
    parameters: { q: { type: 'string' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return result
    },
  }
}

const handle = installToolAliasing(ctx, { watch: ['*'] })
console.log(`installed: ${handle.installed}`)

console.log('\nPlugin A registers memory_search...')
ctx.tools.register(makeTool('memory_search', 'result from A'))

console.log('Plugin B registers memory_search...')
ctx.tools.register(makeTool('memory_search', 'result from B'))

console.log('\nRegistered tools:')
for (const name of store.keys()) {
  console.log(`- ${name}`)
}

console.log('\nBoth implementations are callable:')
for (const [name, def] of store) {
  console.log(`- ${name}: ${await def.execute({ q: 'demo' })}`)
}
