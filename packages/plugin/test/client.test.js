import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const clientFile = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/**
 * 用最小假 React 渲染一次设置页，验证治理中心的数据分支不会在运行期抛错。
 * 不依赖宿主、不启动浏览器。
 */
function renderSection(status) {
  let factory = null
  let captured = null

  const presets = [
    status,
    null, // graph
    null, // plan
    '', // busy
    null, // message
    '', // spec
    Object.entries(status.config?.routes ?? {}).map(([tool, rule]) => ({
      tool,
      by: rule.by ?? 'agent',
      equals: rule.equals ?? '',
      match: rule.match ? JSON.stringify(rule.match) : '',
      index: rule.index == null ? '' : String(rule.index),
    })),
    Object.entries(status.config?.toolPolicies ?? {}).map(([tool, rule]) => ({
      tool,
      allowAgents: Array.isArray(rule.allowAgents) ? rule.allowAgents.join(', ') : '',
      denyAgents: Array.isArray(rule.denyAgents) ? rule.denyAgents.join(', ') : '',
      deny: rule.deny === true,
      reason: rule.reason ?? '',
    })),
  ]
  let hookIndex = 0

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [presets[hookIndex++] ?? initial, () => {}],
    useEffect: () => {},
  }

  const fakeDocument = {
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
  }

  const fakeWindow = {
    __ModuleLoader__: {
      load: (definition) => {
        factory = definition.factory
      },
    },
  }

  const source = fs.readFileSync(clientFile, 'utf8')
  new Function('window', 'document', 'require', 'fetch', source)(
    fakeWindow,
    fakeDocument,
    () => fakeReact,
    async () => {
      throw new Error('fetch should not run during render')
    },
  )

  const loaded = factory(() => fakeReact)
  loaded.apply({
    get(name) {
      if (name !== 'slots') return undefined
      return {
        inject: (_channel, fn) => fn(),
        register: (_definition, component) => {
          captured = component
        },
      }
    },
  })

  assert.equal(typeof captured, 'function')
  return captured({})
}

function collectText(node, out = []) {
  if (node == null) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  for (const child of node.children ?? []) collectText(child, out)
  return out
}

test('governance section renders dependency, route and policy data', () => {
  const status = {
    profile: 'desktop',
    bundles: ['@deepseek-ai/dsh-base', 'dsh-coexist-plugin', 'dsh-demo'],
    report: {
      tools: {
        aliases: [],
        fallbacks: [],
        routes: [{ tool: 'memory_search', target: 'backup', reason: 'agent' }],
        stats: {
          memory_search: {
            calls: 3,
            errors: 0,
            blocked: 1,
            totalMs: 30,
            p95: 20,
            agents: {
              'agent-x': { calls: 3, errors: 0, blocked: 1, totalMs: 30, p95: 20 },
            },
          },
        },
        slowCalls: [{ tool: 'memory_search', agent: 'agent-x', durationMs: 20 }],
      },
      commands: { aliases: [] },
      providers: { aliases: [], conflicts: [] },
      failures: [],
    },
    config: {
      routes: { memory_search: { by: 'agent', equals: 'agent-x' } },
      toolPolicies: { memory_search: { allowAgents: ['agent-x'] } },
    },
    graph: {
      bundles: ['@deepseek-ai/dsh-base', 'dsh-coexist-plugin', 'dsh-demo'],
      bundleInfo: [
        {
          name: 'dsh-demo',
          version: '1.0.0',
          dependencies: { 'dsh-coexist-plugin': '1.0.0' },
          peers: [{ name: 'foo', range: '^1.0.0', installed: null }],
        },
      ],
      cycles: [['dsh-demo', 'dsh-coexist-plugin']],
      conflicts: [
        {
          resource: { type: 'peer', key: 'foo' },
          owners: ['dsh-demo'],
          detail: 'dsh-demo 需要 ^1.0.0；未安装',
          suggestedVersion: '1.0.0',
        },
      ],
    },
    backups: [],
  }

  const text = collectText(renderSection(status)).join('\n')
  assert.match(text, /插件治理中心/)
  assert.match(text, /依赖与加载顺序/)
  assert.match(text, /dsh-demo @ 1\.0\.0/)
  assert.match(text, /版本缺口 \/ 缺失 peer/)
  assert.match(text, /循环依赖/)
  assert.match(text, /p95 20ms/)
  assert.match(text, /慢调用 Top/)
  assert.match(text, /别名路由/)
  assert.match(text, /工具策略与调用/)
  assert.match(text, /memory_search/)
  assert.match(text, /1 拦截/)
})
