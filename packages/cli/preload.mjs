import { appendFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { installPrototypePatch } from './src/preload/patch.js'

const logFile =
  process.env.DSH_COEXIST_LOG ??
  path.join(os.homedir(), '.dsh', 'coexist', 'desktop', 'preload.log')

function logLine(message) {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true })
    appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // Logging must never break the host.
  }
}

logLine(
  `preload start argv=${JSON.stringify(process.argv)} ` +
    `electronRunAsNode=${process.env.ELECTRON_RUN_AS_NODE ?? ''} ` +
    `nodeOptions=${process.env.NODE_OPTIONS ? 'yes' : 'no'}`,
)

const watch = (process.env.DSH_COEXIST_WATCH ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)

let toolsPath = process.env.DSH_COEXIST_TOOLS_PATH
if (!toolsPath) {
  try {
    toolsPath = createRequire(process.argv[1] ?? process.cwd()).resolve('@deepseek-ai/dsh-tools')
  } catch {
    // Keep looking below; the caller may set DSH_COEXIST_TOOLS_PATH.
  }
}

if (!toolsPath) {
  logLine('preload failed: cannot resolve @deepseek-ai/dsh-tools')
  console.warn('[coexist] cannot resolve @deepseek-ai/dsh-tools; preload skipped')
} else {
  try {
    logLine(`preload tools=${toolsPath}`)
    const requireFromDsh = createRequire(toolsPath)
    const mod = await import(pathToFileURL(toolsPath).href)
    const ToolsService = [mod.ToolsService, mod.ToolRuntime, mod.default].find(
      (candidate) => typeof candidate?.prototype?.register === 'function',
    )
    if (!ToolsService) {
      throw new Error('no tool registry class with register() found')
    }

    let scopeOf
    try {
      const scopePath = requireFromDsh.resolve('@deepseek-ai/dsh-scope')
      ;({ scopeOf } = await import(pathToFileURL(scopePath).href))
    } catch {
      // Scope isolation falls back to a single global bucket.
    }

    installPrototypePatch(ToolsService, {
      watch,
      auto: watch.length === 0,
      scopeOf,
      logFile,
    })
  } catch (err) {
    logLine(`preload failed: ${err.stack ?? err.message}`)
    console.warn(`[coexist] preload failed: ${err.message}`)
  }
}
