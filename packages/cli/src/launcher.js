import fs from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { coexistDir, resolveHome, resolveProfile } from './paths.js'
import { loadGraph } from './graph.js'
import { buildPlan } from './plan.js'
import { applyPlan } from './apply.js'

export const RUN_HELP = `dsh-coexist run [launcher options] -- <dsh args...>

  Boot DSH with the coexist preload installed before any plugin loads.
  By default it auto-detects the DSH CLI and auto-detects duplicate tools.

Launcher options:
  --config <file>    optional config (default: $DSH_HOME/coexist/config.json)
  --watch <names>    debug override; default is auto-detect duplicates
  --dsh-bin <file>   debug override; default is auto-detect the DSH CLI
  --home <dir>       DSH_HOME
  --yes              apply the preflight repair plan before boot
  --no-preflight     skip the pre-boot scan/plan
  -h, --help         show this help

Everything after -- is passed to DSH.`

export function parseRunArgs(argv) {
  const options = {
    config: null,
    dshBin: null,
    watch: null,
    home: null,
    yes: false,
    preflight: true,
    help: false,
    dshArgs: [],
  }

  let index = 0
  for (; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      index += 1
      break
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--config') options.config = argv[++index]
    else if (arg === '--dsh-bin') options.dshBin = argv[++index]
    else if (arg === '--watch') options.watch = argv[++index]
    else if (arg === '--home') options.home = argv[++index]
    else if (arg === '--yes') options.yes = true
    else if (arg === '--no-preflight') options.preflight = false
    else options.dshArgs.push(arg)
  }

  options.dshArgs.push(...argv.slice(index))
  return options
}

export function normalizeWatch(value) {
  if (Array.isArray(value)) {
    return value.map((name) => String(name).trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value.split(',').map((name) => name.trim()).filter(Boolean)
  }
  return []
}

export async function loadConfig(home, configPath) {
  const file = configPath
    ? path.resolve(configPath)
    : path.join(coexistDir(home), 'config.json')

  try {
    const text = await fs.readFile(file, 'utf8')
    return { file, config: JSON.parse(text) }
  } catch (err) {
    if (err.code === 'ENOENT') return { file, config: {} }
    throw new Error(`Failed to read coexist config ${file}: ${err.message}`)
  }
}

export function findDshBin() {
  const candidates = []
  const push = (value) => {
    if (value) candidates.push(value)
  }

  push(process.env.DSH_BIN)
  push(process.env.DSH_COEXIST_DSH_BIN)

  try {
    push(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js'))
  } catch {
    // The CLI may not be installed next to DSH; keep looking.
  }

  if (process.platform === 'win32' && process.env.APPDATA) {
    push(
      path.join(
        process.env.APPDATA,
        'npm',
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'lib',
        'bin.js',
      ),
    )
  }

  const npxRoot =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
      : path.join(process.env.HOME ?? '', '.npm', '_npx')

  try {
    for (const entry of readdirSync(npxRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      push(
        path.join(
          npxRoot,
          entry.name,
          'node_modules',
          '@deepseek-ai',
          'dsh',
          'lib',
          'bin.js',
        ),
      )
    }
  } catch {
    // No npx cache on this machine.
  }

  const existing = candidates.filter((candidate) => {
    try {
      return existsSync(candidate)
    } catch {
      return false
    }
  })
  if (existing.length === 0) return null

  existing.sort((left, right) => {
    try {
      return statSync(right).mtimeMs - statSync(left).mtimeMs
    } catch {
      return 0
    }
  })
  return existing[0]
}

export function resolveDshBin(explicit) {
  const candidate = explicit ?? findDshBin()
  if (!candidate) {
    throw new Error(
      'Could not find the DSH CLI. Install @deepseek-ai/dsh, or pass --dsh-bin as a debug override.',
    )
  }

  const resolved = path.resolve(candidate)
  if (!existsSync(resolved)) {
    throw new Error(`DSH CLI not found: ${resolved}`)
  }
  return resolved
}

export function resolveToolsEntry(dshBin) {
  const requireFromDsh = createRequire(dshBin)
  return requireFromDsh.resolve('@deepseek-ai/dsh-tools')
}

function inferProfile(args = []) {
  const index = args.indexOf('--profile')
  if (index !== -1 && args[index + 1]) return args[index + 1]
  const first = args.find((arg) => !arg.startsWith('-'))
  if (first && /^[a-z][a-z0-9_-]*$/i.test(first)) return first
  return 'web'
}

async function runPreflight(home, options) {
  const profile = inferProfile(options.dshArgs)
  try {
    const graph = await loadGraph({
      home,
      ...resolveProfile(home, profile),
      scanPorts: false,
      scanLogs: false,
      scanSources: true,
    })
    const plan = buildPlan(graph)
    const auto = plan.actions.filter((action) => action.kind !== 'manual')

    if (graph.conflicts.length === 0) {
      console.log('[coexist] preflight: no conflicts')
      return
    }

    console.log(
      `[coexist] preflight: ${graph.conflicts.length} conflict(s), ${auto.length} automatic repair(s)`,
    )
    if (options.yes && auto.length > 0) {
      const result = await applyPlan({ home, graph, plan })
      console.log(
        `[coexist] preflight applied ${result.applied.length} action(s); backup ${result.backup}`,
      )
    } else {
      console.log('[coexist] preflight is read-only; re-run with --yes to apply repairs')
    }
  } catch (error) {
    console.warn(`[coexist] preflight skipped: ${error.message}`)
  }
}

export async function runDsh(options = {}) {
  const home = resolveHome(options.home)
  const { file: configFile, config } = await loadConfig(home, options.config)
  const watch = options.watch ? normalizeWatch(options.watch) : normalizeWatch(config.watch)

  if (options.preflight !== false) {
    await runPreflight(home, options)
  }

  const dshBin = resolveDshBin(options.dshBin)
  const toolsEntry = resolveToolsEntry(dshBin)
  const preloadPath = fileURLToPath(new URL('../preload.mjs', import.meta.url))

  const env = {
    ...process.env,
    DSH_COEXIST_WATCH: watch.join(','),
    DSH_COEXIST_TOOLS_PATH: toolsEntry,
  }

  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(preloadPath).href, dshBin, ...options.dshArgs],
    { stdio: 'inherit', env },
  )

  const forward = (signal) => {
    if (!child.killed) child.kill(signal)
  }
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)

  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward)
      process.off('SIGTERM', forward)
      if (signal) {
        resolve(signal === 'SIGINT' ? 130 : 143)
      } else {
        resolve(code ?? 0)
      }
    })
  })
}
