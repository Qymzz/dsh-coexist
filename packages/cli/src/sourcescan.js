import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_FILES = 400
const MAX_FILE_SIZE = 2 * 1024 * 1024
const SOURCE_RE = /\.(m?js|cjs|ts)$/i

const COMMAND_RE =
  /commands\s*\.\s*register\s*\(\s*\{[\s\S]{0,500}?\bname\s*:\s*['"]([a-z][a-z0-9_-]*)['"]/g
const ADAPTER_ROUTES_RE = /registerAdapter\s*\(\s*\[([^\]]{0,500})\]/g
const CONFIGURABLE_RE = /registerConfigurableProviders\s*\(\s*\[([\s\S]{0,3000}?)\]/g
const QUOTED_RE = /['"]([A-Za-z0-9@/_.:-]+)['"]/g
const CONFIGURABLE_PROVIDER_RE = /\bprovider\s*:\s*['"]([A-Za-z0-9@/_.:-]+)['"]/g
const SLOT_BLOCK_RE = /\bslots?\s*\.\s*register\s*\(\s*\{([\s\S]{0,600}?)\}\s*,/g
const SLOT_NAME_RE = /\bname\s*:\s*['"]([A-Za-z0-9_.:-]+)['"]/
const SLOT_ID_RE = /\bid\s*:\s*['"]([A-Za-z0-9_.:-]+)['"]/
const LOCK_FILE_RE = /['"]([A-Za-z0-9_.-]+\.lock)['"]/g
const LOCK_DEP_RE = /['"](proper-lockfile|lockfile|file-lock|single-instance|lockfile-lite)['"]/g

async function listSourceFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length > 0 && files.length < MAX_FILES) {
    const dir = stack.pop()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (SOURCE_RE.test(entry.name)) files.push(full)
      if (files.length >= MAX_FILES) break
    }
  }
  return files
}

function collect(regex, text, sink) {
  regex.lastIndex = 0
  let match
  while ((match = regex.exec(text))) {
    if (match[1]) sink.add(match[1])
  }
}

function addResource(resources, type, key, owner, file) {
  if (!key) return
  const bucket = resources[type] ?? (resources[type] = new Map())
  const owners = bucket.get(key) ?? []
  if (!owners.some((item) => item.owner === owner)) owners.push({ owner, file })
  bucket.set(key, owners)
}

/**
 * 扫描第三方插件源码里“会争抢同名资源”的注册语句。
 * 这是保守的静态证据：只认字符串字面量，变量/动态名字会漏；漏报比误报安全。
 */
export async function scanBundleSources(bundleInfo) {
  const resources = { command: new Map(), provider: new Map(), 'ui-slot': new Map(), 'file-lock': new Map() }

  for (const bundle of bundleInfo) {
    if (!bundle?.dir) continue
    const files = await listSourceFiles(bundle.dir)
    for (const file of files) {
      let text
      try {
        const stat = await fs.stat(file)
        if (stat.size > MAX_FILE_SIZE) continue
        text = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      const relative = path.relative(bundle.dir, file)

      const commands = new Set()
      collect(COMMAND_RE, text, commands)
      for (const name of commands) addResource(resources, 'command', name, bundle.name, relative)

      const providers = new Set()
      for (const match of text.matchAll(ADAPTER_ROUTES_RE)) {
        const list = new Set()
        collect(QUOTED_RE, match[1], list)
        for (const provider of list) providers.add(provider)
      }
      for (const match of text.matchAll(CONFIGURABLE_RE)) {
        const list = new Set()
        collect(CONFIGURABLE_PROVIDER_RE, match[1], list)
        for (const provider of list) providers.add(provider)
      }
      for (const provider of providers) {
        addResource(resources, 'provider', provider, bundle.name, relative)
      }

      const slots = new Set()
      for (const match of text.matchAll(SLOT_BLOCK_RE)) {
        const name = SLOT_NAME_RE.exec(match[1])?.[1]
        const id = SLOT_ID_RE.exec(match[1])?.[1]
        // 没有显式 id 时宿主会生成唯一 id，不构成冲突。
        if (name && id) slots.add(`${name}#${id}`)
      }
      for (const slot of slots) addResource(resources, 'ui-slot', slot, bundle.name, relative)

      const locks = new Set()
      collect(LOCK_FILE_RE, text, locks)
      collect(LOCK_DEP_RE, text, locks)
      for (const lock of locks) addResource(resources, 'file-lock', lock, bundle.name, relative)
    }
  }

  return resources
}

const HINTS = {
  command: '运行期会自动改成 /name__coexistN；也可在 profile patch 里停用其中一个命令',
  provider: '运行期会把后注册的 provider 改成 provider__coexistN；设置页可能仍共用命名空间',
  'ui-slot': 'UI 插槽在浏览器客户端注册，host 插件无法改名；需要停用其中一个或等客户端侧支持',
  'file-lock': '文件锁没有统一注册 API；需要改配置、换存储目录或做进程隔离',
}

/**
 * 把扫描到的资源按 owner 聚合；只保留两个及以上插件争抢的项。
 * UI 插槽和文件锁只做提示（info），因为它们不能由 host 插件在运行期安全改名。
 */
export function detectSourceConflicts(resources) {
  const conflicts = []
  for (const [type, bucket] of Object.entries(resources)) {
    for (const [key, owners] of bucket) {
      if (owners.length < 2) continue
      const runtimeHandled = type === 'command' || type === 'provider'
      conflicts.push({
        resource: { type, key },
        owners: owners.map((item) => item.owner),
        evidence: owners.map((item) => `${item.owner}:${item.file}`),
        strategies: runtimeHandled ? ['runtime-alias'] : ['manual'],
        recommended: runtimeHandled ? 'runtime-alias' : 'manual',
        severity: runtimeHandled ? 'conflict' : 'info',
        detail: HINTS[type],
        hint: HINTS[type],
      })
    }
  }
  return conflicts
}
