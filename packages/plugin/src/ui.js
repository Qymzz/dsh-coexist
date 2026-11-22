import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const requireFromPlugin = createRequire(import.meta.url)
const ROUTE_PREFIX = '/coexist-api/'

function resolveHome(config = {}) {
  return path.resolve(
    config.home ?? process.env.DSH_COEXIST_HOME ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  )
}

function resolveProfile(home, config = {}) {
  if (config.profile) return config.profile
  if (process.env.DSH_COEXIST_PROFILE) return process.env.DSH_COEXIST_PROFILE
  return fs.existsSync(path.join(home, 'profiles', 'desktop')) ? 'desktop' : 'web'
}

/** 从 loader 的 baseUrl 反推当前 profile 与 home，避免 UI 操作错 profile。 */
export function detectProfile(ctx, config = {}) {
  let home = config.home ?? process.env.DSH_COEXIST_HOME ?? process.env.DSH_HOME ?? null
  if (config.profile && home) return { home: path.resolve(home), profile: config.profile }

  try {
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : ctx.loader
    const baseUrl = loader?.config?.baseUrl ?? ctx.baseUrl
    if (typeof baseUrl === 'string' && baseUrl.length > 0) {
      const dir = baseUrl.startsWith('file:') ? fileURLToPath(baseUrl) : path.resolve(baseUrl)
      const profilesDir = path.dirname(dir)
      if (path.basename(profilesDir) === 'profiles') {
        const detectedHome = path.dirname(profilesDir)
        return {
          home: home ? path.resolve(home) : detectedHome,
          profile: config.profile ?? path.basename(dir),
        }
      }
    }
  } catch {
    // 没有 loader 时退回默认探测。
  }

  const resolvedHome = resolveHome({ ...config, home })
  return { home: resolvedHome, profile: resolveProfile(resolvedHome, config) }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, file)
}

async function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/** 只接受本机回环连接；IPC/进程内调用没有 remoteAddress，按本机处理。 */
export function isLoopbackAddress(address) {
  if (!address) return true
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalized === '::1' || /^127\./.test(normalized)
}

/** 浏览器 POST 会带 Origin；http(s) 必须同源，桌面自定义协议/无 Origin 视为应用内调用。 */
export function isSameOrigin(headers = {}) {
  const origin = headers.origin
  if (!origin || origin === 'null') return true
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
    return url.host === headers.host
  } catch {
    return false
  }
}

/**
 * 写接口的请求闸门：
 * - 只接受 POST + application/json，跨站表单/text-plain 因此进不来；
 * - 只接受本机回环，避免 DSH 绑定局域网地址时被外部直接调用；
 * - Origin 存在时必须同源。
 */
export function rejectReason(req) {
  if (req.method !== 'POST') return 'POST required'
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return 'local requests only'
  if (!isSameOrigin(req.headers)) return 'cross-origin request rejected'
  const type = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!type.startsWith('application/json')) return 'application/json required'
  return null
}

/** 插件自带的 CLI 依赖（dsh-coexist-cli），无需用户配置路径。 */
function bundledCli() {
  try {
    const pkgPath = requireFromPlugin.resolve('dsh-coexist-cli/package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['dsh-coexist']
    if (!rel) return null
    const bin = path.resolve(path.dirname(pkgPath), rel)
    if (!fs.existsSync(bin)) return null
    return { ok: true, file: process.execPath, prefix: [bin], display: bin, source: 'dependency' }
  } catch {
    return null
  }
}

/** CLI 解析顺序：显式配置 > 环境变量 > 插件依赖 > PATH。 */
export function resolveCli(config = {}) {
  const explicit = config.cliPath ?? process.env.DSH_COEXIST_CLI
  if (explicit) {
    const resolved = path.resolve(explicit)
    if (!fs.existsSync(resolved)) return { ok: false, error: `CLI not found: ${resolved}` }
    if (/\.(c|m)?js$/i.test(resolved)) {
      return { ok: true, file: process.execPath, prefix: [resolved], display: resolved, source: 'configured' }
    }
    return { ok: true, file: resolved, prefix: [], display: resolved, source: 'configured' }
  }

  const bundled = bundledCli()
  if (bundled) return bundled

  return {
    ok: true,
    file: process.platform === 'win32' ? 'dsh-coexist.cmd' : 'dsh-coexist',
    prefix: [],
    display: 'dsh-coexist',
    source: 'path',
  }
}

async function runCli(cli, args, { home } = {}) {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli.file)
  try {
    const { stdout, stderr } = await execFileAsync(cli.file, [...cli.prefix, ...args], {
      env: { ...process.env, DSH_HOME: home },
      timeout: 10 * 60_000,
      windowsHide: true,
      shell: needsShell,
      maxBuffer: 24 * 1024 * 1024,
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    return {
      ok: false,
      error: error?.stderr?.trim() || error?.message || String(error),
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
    }
  }
}

function parseCliJson(result) {
  if (!result.ok) return result
  try {
    return { ok: true, value: JSON.parse(result.stdout), stderr: result.stderr }
  } catch {
    return { ok: false, error: `CLI did not return JSON: ${result.stdout.slice(0, 400)}` }
  }
}

function listBackups(home, profile) {
  const marker = `${path.sep}profiles${path.sep}${profile}${path.sep}`
  try {
    return fs
      .readdirSync(path.join(home, 'coexist', 'backups'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((id) => {
        const manifest = readJson(path.join(home, 'coexist', 'backups', id, 'manifest.json'))
        return (manifest?.files ?? []).some((item) => String(item.file).includes(marker))
      })
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function statusPayload(home, profile) {
  const coexistDir = path.join(home, 'coexist')
  const profileDir = path.join(home, 'profiles', profile)
  const manifest = readJson(path.join(profileDir, 'package.json'))
  return {
    home,
    profile,
    profileDir,
    hostVersion: (() => {
      const fromProfile = readJson(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      return fromProfile?.version ?? null
    })(),
    report: readJson(path.join(coexistDir, 'report.json')),
    state: readJson(path.join(coexistDir, 'state.json')),
    graph: readJson(path.join(coexistDir, 'graph.json')),
    config: readJson(path.join(coexistDir, 'config.json')) ?? {},
    bundles: manifest?.dsh?.profile?.bundles ?? [],
    dependencies: manifest?.dependencies ?? {},
    backups: listBackups(home, profile),
  }
}

/**
 * 给桌面/网页设置页提供本地 HTTP 接口。
 * 所有写操作仍由 CLI 执行，避免 UI 与 CLI 两套逻辑分叉。
 */
export function installUiRoutes(ctx, options = {}) {
  let installed = false

  const install = (webServer) => {
    if (installed || !webServer) return installed
    installed = true

    const { home, profile } = detectProfile(ctx, options)
    const cli = resolveCli(options)

    const routes = {
      status: async () => ({ ok: true, ...statusPayload(home, profile), cli }),
      check: async () =>
        parseCliJson(
          await runCli(cli, ['check', '--home', home, '--profile', profile, '--json', '--no-log-scan'], { home }),
        ),
      plan: async () =>
        parseCliJson(
          await runCli(
            cli,
            ['plan', '--home', home, '--profile', profile, '--json', '--no-log-scan', '--no-diff'],
            { home },
          ),
        ),
      apply: async (body) => {
        const args = ['apply', '--home', home, '--profile', profile, '--yes', '--no-diff', '--json']
        if (body.planId) args.push('--plan', String(body.planId))
        return parseCliJson(await runCli(cli, args, { home }))
      },
      rollback: async (body) => {
        const available = listBackups(home, profile)
        const id = body.id ? String(body.id) : available[0]
        if (!id) return { ok: false, error: 'no backup for this profile' }
        if (!available.includes(id)) {
          return { ok: false, error: `backup not found for profile ${profile}: ${id}`, available }
        }
        const args = ['rollback', '--home', home, '--profile', profile, '--id', id, '--json']
        if (body.reinstall !== false) args.push('--reinstall')
        return parseCliJson(await runCli(cli, args, { home }))
      },
      install: async (body) => {
        if (!body.spec) return { ok: false, error: 'missing spec' }
        return parseCliJson(
          await runCli(
            cli,
            ['install', String(body.spec), '--home', home, '--profile', profile, '--json'],
            { home },
          ),
        )
      },
      uninstall: async (body) => {
        if (!body.name) return { ok: false, error: 'missing name' }
        return parseCliJson(
          await runCli(
            cli,
            ['uninstall', String(body.name), '--home', home, '--profile', profile, '--json'],
            { home },
          ),
        )
      },
      'free-port': async (body) => {
        const port = Number(body.port)
        if (!Number.isInteger(port)) return { ok: false, error: 'invalid port' }
        return parseCliJson(
          await runCli(cli, ['free-port', String(port), '--yes', '--json'], { home }),
        )
      },
      prefer: async (body) => {
        if (!body.plugin) return { ok: false, error: 'missing plugin' }
        return parseCliJson(
          await runCli(
            cli,
            ['prefer', String(body.plugin), '--home', home, '--profile', profile, '--json'],
            { home },
          ),
        )
      },
      config: async (body) => {
        const file = path.join(home, 'coexist', 'config.json')
        const current = readJson(file) ?? {}
        if (!body.patch || typeof body.patch !== 'object') {
          return { ok: true, config: current, file }
        }
        const next = { ...current, ...body.patch }
        await writeJsonAtomic(file, next)
        return { ok: true, config: next, file }
      },
    }

    for (const [name, handler] of Object.entries(routes)) {
      try {
        ctx.effect(
          () =>
            webServer.register({
              kind: 'exact',
              path: `${ROUTE_PREFIX}${name}`,
              handler: async (req, res) => {
                const rejected = rejectReason(req)
                if (rejected) {
                  sendJson(res, rejected === 'POST required' ? 405 : 403, { ok: false, error: rejected })
                  return
                }
                try {
                  const body = await readBody(req)
                  const result = await handler(body)
                  sendJson(res, result?.ok === false ? 400 : 200, result)
                } catch (error) {
                  sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
                }
              },
            }),
          `coexist-ui: ${name}`,
        )
      } catch (error) {
        options.log?.(`[coexist] ui route failed (${name}): ${error.message}`)
      }
    }

    options.log?.(`[coexist] ui routes active: ${Object.keys(routes).length} (${profile})`)
    return true
  }

  let webServer
  try {
    webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
  } catch {
    webServer = undefined
  }
  if (install(webServer)) return true

  try {
    ctx.on('internal/service', (name, service) => {
      if (name === 'webServer' && service) install(service)
    })
  } catch {
    // 没有事件服务时只能依赖 apply 时的 webServer。
  }
  return false
}
