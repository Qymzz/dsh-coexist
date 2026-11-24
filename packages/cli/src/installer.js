import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createBackup, rollbackById } from './backup.js'
import { resolveHome, resolveProfile, profilePackageJson, profilePatch } from './paths.js'
import { satisfies } from './semver.js'
import { dumpConfig } from './dumpconfig.js'
import { desktopDir, restoreDesktop } from './desktop.js'
import { assertSafePackageName, resolveInside } from './safe-path.js'

const execFileAsync = promisify(execFile)
const CLI_PACKAGE = 'dsh-coexist-cli'

const KNOWN_APP_DIRS = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH NEXT', 'DSH NEXT.exe'),
  '/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT',
  '/opt/DSH NEXT/dsh-next',
]

const ASAR_DSH_PACKAGE = '/node_modules/@deepseek-ai/dsh/package.json'

function readJsonSync(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await fsp.rename(tmp, file)
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EPERM') {
      await fsp.rm(file, { force: true })
      await fsp.rename(tmp, file)
      return
    }
    await fsp.rm(tmp, { force: true })
    throw err
  }
}

async function pathExists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

function findAsarEntry(node, prefix, wanted) {
  for (const [name, child] of Object.entries(node?.files ?? {})) {
    const current = `${prefix}/${name}`
    if (current === wanted) return child
    if (child?.files) {
      const hit = findAsarEntry(child, current, wanted)
      if (hit) return hit
    }
  }
  return null
}

/** 只读取 asar 头和一个条目，避免把 200MB 的 app.asar 整个载入内存。 */
export function readAsarEntry(asarFile, entryPath) {
  let fd
  try {
    fd = fs.openSync(asarFile, 'r')
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const contentBase = 8 + head.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 16)
    const header = JSON.parse(headerBuf.toString('utf8'))

    const candidates = entryPath.startsWith('/') ? [entryPath] : [entryPath, `/${entryPath}`]
    let entry = null
    for (const candidate of candidates) {
      entry = findAsarEntry(header, '', candidate)
      if (entry) break
    }
    if (!entry || typeof entry.size !== 'number') return null

    const buf = Buffer.alloc(entry.size)
    fs.readSync(fd, buf, 0, entry.size, contentBase + Number(entry.offset ?? 0))
    return buf
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

export function readAsarJson(asarFile, entryPath) {
  const buf = readAsarEntry(asarFile, entryPath)
  if (!buf) return null
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

/** 定位桌面版 app.asar；找不到返回 null，由版本检测继续尝试其他来源。 */
export function findDesktopAsar(explicitApp) {
  const candidates = [explicitApp, process.env.DSH_DESKTOP_APP, ...KNOWN_APP_DIRS].filter(Boolean)
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    const dir = resolved.endsWith('.exe') || resolved.endsWith('dsh-next')
      ? path.dirname(resolved)
      : resolved
    for (const asar of [
      path.join(dir, 'resources', 'app.asar'),
      path.join(dir, 'Contents', 'Resources', 'app.asar'),
      path.join(dir, 'app.asar'),
    ]) {
      if (fs.existsSync(asar)) return { appExe: resolved, asar }
    }
  }
  return null
}

function findPackageUpwards(startDir, name) {
  let dir = startDir
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = readJsonSync(path.join(dir, 'node_modules', name, 'package.json'))
    if (manifest) return manifest
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function readHostPackageVersion(name, host, profileDir) {
  const readAsar = () => {
    if (!host.asar) return null
    return readAsarJson(host.asar, `/node_modules/${name}/package.json`)
  }
  const readProfile = () => findPackageUpwards(profileDir, name)

  const fromProfile = host.source !== 'desktop'
  const first = fromProfile ? readProfile() : readAsar()
  if (first?.version) return first.version
  const second = fromProfile ? readAsar() : readProfile()
  return second?.version ?? null
}

function detectCliVersion() {
  const entry = process.argv[1]
  if (!entry) return null
  let dir = path.dirname(entry)
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = readJsonSync(path.join(dir, 'package.json'))
    if (manifest?.name === '@deepseek-ai/dsh' && manifest.version) return manifest.version
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 识别宿主 DSH 版本。优先级：显式参数/环境变量 > 正在运行的 dsh CLI > profile 所在依赖树 > 桌面 asar。
 */
export function detectDshVersion(options = {}) {
  const explicit = options.dshVersion ?? process.env.DSH_VERSION
  if (explicit) {
    // 显式版本覆盖只替换版本号，仍保留桌面 appExe/asar，供内置 pnpm 使用。
    const desktop = findDesktopAsar(options.app)
    return {
      version: explicit,
      source: 'env',
      asar: desktop?.asar ?? null,
      appExe: desktop?.appExe ?? null,
    }
  }

  const cliVersion = detectCliVersion()
  if (cliVersion) return { version: cliVersion, source: 'cli' }

  const home = resolveHome(options.home)
  const profile = resolveProfile(home, options.profile ?? defaultProfile(home))
  const desktop = findDesktopAsar(options.app)

  const local = findPackageUpwards(profile.dir, '@deepseek-ai/dsh')
  if (local?.version) {
    return { version: local.version, source: 'profile', asar: desktop?.asar ?? null, appExe: desktop?.appExe ?? null }
  }

  if (desktop) {
    const manifest = readAsarJson(desktop.asar, ASAR_DSH_PACKAGE)
    if (manifest?.version) {
      return { version: manifest.version, source: 'desktop', asar: desktop.asar, appExe: desktop.appExe }
    }
  }

  return { version: null, source: null, asar: desktop?.asar ?? null, appExe: desktop?.appExe ?? null }
}

/** 桌面用户默认就是 desktop；没有该 profile 时退回 web。 */
export function defaultProfile(home) {
  return fs.existsSync(path.join(home, 'profiles', 'desktop')) ? 'desktop' : 'web'
}

export function readInstalledManifest(profileDir, name) {
  return readJsonSync(path.join(profileDir, 'node_modules', name, 'package.json'))
}

function hostPackagesFor(manifest, host, profileDir) {
  const names = new Set(['@deepseek-ai/dsh'])
  for (const name of Object.keys(manifest?.peerDependencies ?? {})) names.add(name)
  const versions = {}
  for (const name of names) {
    versions[name] =
      name === '@deepseek-ai/dsh'
        ? host.version
        : readHostPackageVersion(name, host, profileDir)
  }
  return versions
}

/**
 * 判断一个插件能否在宿主版本上运行。
 * engines.dsh 与 peerDependencies 都参与；读不到宿主版本时记为 unknown，不误报为不兼容。
 */
export function evaluateCompatibility(manifest, host, profileDir) {
  const checks = []
  const range = manifest?.engines?.dsh
  if (range) {
    const ok = host.version ? satisfies(host.version, range) : null
    checks.push({
      kind: 'engine',
      name: 'dsh',
      range,
      actual: host.version,
      ok,
      required: host.version ? null : 'unknown host version',
    })
  }

  const hostVersions = hostPackagesFor(manifest, host, profileDir)
  for (const [name, peerRange] of Object.entries(manifest?.peerDependencies ?? {})) {
    const actual = hostVersions[name] ?? null
    const optional = manifest?.peerDependenciesMeta?.[name]?.optional === true
    const ok = actual ? satisfies(actual, peerRange) : null
    checks.push({
      kind: 'peer',
      name,
      range: peerRange,
      actual,
      ok,
      optional,
      required: actual ? null : 'package not found in host',
    })
  }

  const blocked = checks.filter((check) => check.ok === false)
  return {
    status: blocked.length > 0 ? 'blocked' : checks.some((c) => c.ok === null) ? 'unknown' : 'ok',
    checks,
  }
}

function parseViewJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function inspectRemote(spec, runCommand) {
  const runner = runCommand ?? defaultRunCommand
  const cli = findNpmCli()
  if (!cli) return null
  const attempt = { file: process.execPath, args: [cli, 'view', spec, '--json'] }
  try {
    const { stdout } = await runner(attempt.file, attempt.args, { timeout: 60_000 })
    const data = parseViewJson(stdout)
    if (!data) return null
    const entry = Array.isArray(data) ? data[data.length - 1] : data
    if (!entry?.name) return null
    return {
      name: entry.name,
      version: entry.version ?? null,
      manifest: {
        name: entry.name,
        version: entry.version,
        engines: entry.engines,
        peerDependencies: entry.peerDependencies,
        peerDependenciesMeta: entry.peerDependenciesMeta,
        dsh: entry.dsh,
      },
      source: 'npm',
    }
  } catch {
    return null
  }
}

async function inspectPlugin(options) {
  const profileDir = options.profileDir
  const spec = options.spec
  const abs = path.resolve(spec)
  if (fs.existsSync(path.join(abs, 'package.json'))) {
    const manifest = readJsonSync(path.join(abs, 'package.json'))
    const name = assertSafePackageName(manifest?.name)
    return { name, version: manifest.version, manifest: { ...manifest, name }, source: 'path', dir: abs }
  }

  let installed = null
  try {
    installed = readInstalledManifest(profileDir, assertSafePackageName(spec))
  } catch {
    // spec 不是裸包名（例如本地路径或 name@version），跳过已安装查询。
  }
  if (installed) {
    const name = assertSafePackageName(installed.name)
    return { name, version: installed.version, manifest: { ...installed, name }, source: 'profile' }
  }

  if (!findNpmCli()) {
    throw new Error('npm CLI not found; install Node.js with npm, or use a local plugin path')
  }

  const remote = await inspectRemote(spec, options.runCommand)
  if (remote) {
    const name = assertSafePackageName(remote.name)
    return { ...remote, name, manifest: { ...remote.manifest, name } }
  }

  throw new Error(`Cannot resolve plugin: ${spec}`)
}

function resolveBundledPnpm(appExe) {
  if (!appExe) return null
  const base = path.join(path.dirname(appExe), 'resources', 'runtime')
  for (const platform of ['x64', 'arm64']) {
    const root = path.join(base, platform, 'primary-runtime', 'dependencies')
    const node = path.join(root, 'node', 'bin', 'node.exe')
    const pnpm = path.join(root, 'pnpm', 'bin', 'pnpm.cjs')
    if (process.platform !== 'win32') continue
    if (fs.existsSync(node) && fs.existsSync(pnpm)) return { name: 'pnpm', file: node, prefix: [pnpm] }
  }
  return null
}

async function defaultRunCommand(file, args, options = {}) {
  return execFileAsync(file, args, {
    cwd: options.cwd,
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
  })
}

async function tryRun(runner, attempts, cwd) {
  if (attempts.length === 0) {
    return { ok: false, errors: ['no package manager available (npm CLI or bundled pnpm not found)'] }
  }
  const errors = []
  for (const attempt of attempts) {
    try {
      const output = await runner(attempt.file, [...(attempt.prefix ?? []), ...attempt.args], {
        cwd,
        timeout: 180_000,
      })
      return { ok: true, pm: attempt.name, output }
    } catch (err) {
      errors.push(`${attempt.name}: ${err.stderr?.trim() || err.message}`)
    }
  }
  return { ok: false, errors }
}

function findNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(process.env.ProgramFiles ?? '', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

function npmAttempt(args) {
  const cli = findNpmCli()
  if (!cli) return null
  return { name: 'npm', file: process.execPath, prefix: [cli], args }
}

function managerAttempts(spec, appExe, action) {
  const attempts = []
  const bundled = resolveBundledPnpm(appExe)
  if (bundled) {
    attempts.push({
      name: 'pnpm(bundled)',
      file: bundled.file,
      prefix: bundled.prefix,
      args: [action, spec, '--config.strictDepBuilds=false'],
    })
  }
  if (action === 'add') {
    const attempt = npmAttempt(['install', spec, '--save-exact', '--no-audit', '--no-fund'])
    if (attempt) attempts.push(attempt)
  } else {
    const attempt = npmAttempt(['uninstall', spec, '--no-audit', '--no-fund'])
    if (attempt) attempts.push(attempt)
  }
  return attempts
}

async function copyDir(source, dest) {
  const from = path.resolve(source)
  const to = path.resolve(dest)
  const into = path.relative(from, to)
  const over = path.relative(to, from)
  if (into === '' || (!into.startsWith('..') && !path.isAbsolute(into))) {
    throw new Error(`Refusing to copy into its own source: ${to}`)
  }
  if (over === '' || (!over.startsWith('..') && !path.isAbsolute(over))) {
    throw new Error(`Refusing to delete a parent of the source: ${to}`)
  }
  await fsp.rm(to, { recursive: true, force: true })
  await fsp.mkdir(to, { recursive: true })
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.tmp' || entry.name === 'test') continue
    const entryFrom = path.join(from, entry.name)
    const entryTo = path.join(to, entry.name)
    if (entry.isDirectory()) await copyDir(entryFrom, entryTo)
    else if (entry.isSymbolicLink()) {
      await fsp.symlink(await fsp.readlink(entryFrom), entryTo).catch(() => {})
    } else await fsp.copyFile(entryFrom, entryTo)
  }
}

/** 记录 node_modules 顶层包名（含 scope），用来发现包管理器偷偷 prune 掉的包。 */
export function snapshotNodeModules(profileDir) {
  const root = path.join(profileDir, 'node_modules')
  const names = new Set()
  if (!fs.existsSync(root)) return names
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.ignored' || entry.name === '.pnpm' || entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      const scope = path.join(root, entry.name)
      for (const child of fs.readdirSync(scope, { withFileTypes: true })) {
        if (child.isDirectory()) names.add(`${entry.name}/${child.name}`)
      }
    } else {
      names.add(entry.name)
    }
  }
  return names
}

function findIgnoredCopy(profileDir, name) {
  const safeName = assertSafePackageName(name)
  const ignoredRoot = path.join(profileDir, 'node_modules', '.ignored')
  const exact = resolveInside(ignoredRoot, safeName)
  if (fs.existsSync(exact)) return exact
  for (let index = 1; index <= 20; index += 1) {
    const candidate = resolveInside(ignoredRoot, `${safeName}_${index}`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * pnpm/npm 会把不在依赖树里的包（包括手工安装的共存插件和 peer）移到 .ignored。
 * 安装/卸载后把这类包放回去，避免"装一个插件把另一个插件弄没"。
 */
export async function restorePrunedPackages(profileDir, before) {
  const restored = []
  const nodeModules = path.join(profileDir, 'node_modules')
  for (const raw of before) {
    let name
    try {
      name = assertSafePackageName(raw)
    } catch {
      continue
    }
    const target = resolveInside(nodeModules, name)
    if (fs.existsSync(target)) continue
    const source = findIgnoredCopy(profileDir, name)
    if (!source) continue
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.cp(source, target, { recursive: true, force: true })
    restored.push(name)
  }
  return restored
}

/**
 * 本地开发/自安装：把仓库里的 CLI 作为 file: 依赖一起放进 profile，
 * 这样插件安装后 UI 不依赖 PATH 上的 dsh-coexist。
 * 从 npm 安装时不需要这一步（依赖会按版本解析）。
 */
async function stageLocalCli(profileDir, pluginDir) {
  const candidates = [
    path.join(pluginDir, 'node_modules', CLI_PACKAGE),
    path.resolve(pluginDir, '..', 'cli'),
  ]
  const source = candidates.find((dir) => readJsonSync(path.join(dir, 'package.json'))?.name === CLI_PACKAGE)
  if (!source) return null

  const staged = resolveInside(path.join(profileDir, '.dsh-coexist', 'plugins'), CLI_PACKAGE)
  await copyDir(source, staged)
  return {
    dir: staged,
    // 相对于插件包目录：staged 插件与 CLI 是兄弟目录；node_modules 回退时同理。
    rel: `file:../${CLI_PACKAGE}`,
  }
}

async function rewriteDependency(file, name, value) {
  const manifest = readJsonSync(file)
  if (!manifest) return
  manifest.dependencies ??= {}
  manifest.dependencies[name] = value
  await writeJson(file, manifest)
}

/**
 * 共存插件本身也要被依赖树记录，否则下一次任何安装都会把它 prune 掉。
 * 已存在于 node_modules 时，复制到 profile 内部并写成 file: 依赖。
 */
async function trackCoexistPlugin(profileDir, manifest) {
  const name = 'dsh-coexist-plugin'
  if (!manifest?.dsh?.profile?.bundles?.includes(name)) return null
  if (manifest.dependencies?.[name]) return null
  const current = path.join(profileDir, 'node_modules', name)
  if (!fs.existsSync(path.join(current, 'package.json'))) return null

  const staged = resolveInside(path.join(profileDir, '.dsh-coexist', 'plugins'), name)
  await copyDir(current, staged)
  const cli = await stageLocalCli(profileDir, current)
  if (cli) await rewriteDependency(path.join(staged, 'package.json'), CLI_PACKAGE, cli.rel)
  manifest.dependencies ??= {}
  manifest.dependencies[name] = `file:.dsh-coexist/plugins/${name}`
  return name
}

function ensureBundle(manifest, name) {
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (!bundles.includes(name)) bundles.push(name)
  manifest.dsh.profile.bundles = bundles
  return bundles.includes(name)
}

async function restoreBackupFiles(backup) {
  const restored = []
  for (const item of backup?.manifest?.files ?? []) {
    const source = path.join(backup.dir, item.rel)
    if (!(await pathExists(source))) continue
    await fsp.mkdir(path.dirname(item.file), { recursive: true })
    await fsp.copyFile(source, item.file)
    restored.push(item.file)
  }
  return restored
}

async function removeIfEmpty(dir) {
  try {
    const entries = await fsp.readdir(dir)
    if (entries.length === 0) await fsp.rmdir(dir)
  } catch {
    // 目录不存在或非空都无需处理。
  }
}

/**
 * 卸载后的磁盘清理：
 * - 本地安装会复制到 `.dsh-coexist/plugins/<name>`，卸载时一起删掉；
 * - 卸载共存插件本身时，再删掉随插件分发的 CLI 和旧版快捷方式启动器；
 * - `purge` 时连同 `~/.dsh/coexist`（备份、报告、配置）一起删除。
 */
async function cleanupInstallArtifacts(profileDir, name, home, options = {}) {
  const safeName = assertSafePackageName(name)
  const cleaned = []
  const stagedRoot = path.join(profileDir, '.dsh-coexist', 'plugins')

  const remove = async (target) => {
    if (!(await pathExists(target))) return
    await fsp.rm(target, { recursive: true, force: true })
    cleaned.push(target)
  }

  await remove(resolveInside(stagedRoot, safeName))

  if (safeName === 'dsh-coexist-plugin') {
    await remove(resolveInside(stagedRoot, CLI_PACKAGE))
    const legacy = desktopDir(home)
    if (await pathExists(legacy)) {
      try {
        await restoreDesktop({ home })
        await remove(legacy)
      } catch {
        // 快捷方式恢复失败时不阻断卸载，残留目录由用户手动清理。
      }
    }
  }

  await removeIfEmpty(stagedRoot)
  await removeIfEmpty(path.join(profileDir, '.dsh-coexist'))

  if (options.purge) {
    await remove(path.join(home, 'coexist'))
  }

  return cleaned
}

function verifyPluginDir(profileDir, name) {
  const safeName = assertSafePackageName(name)
  const dir = resolveInside(path.join(profileDir, 'node_modules'), safeName)
  const manifest = readJsonSync(path.join(dir, 'package.json'))
  if (!manifest) return { ok: false, error: `package not found after install: ${dir}` }
  if (manifest.main && !fs.existsSync(path.resolve(dir, manifest.main))) {
    return { ok: false, error: `entry not found: ${manifest.main}` }
  }
  const patch = manifest.dsh?.bundle?.patch
  if (patch && !fs.existsSync(path.resolve(dir, patch))) {
    return { ok: false, error: `bundle patch not found: ${patch}` }
  }
  return { ok: true, dir, manifest, warnings: [] }
}

/**
 * 安装一个插件：版本识别 → 兼容检查 → 备份 → 安装 → 写入 bundles → 校验。
 * 任何一步失败都会恢复 package.json / lockfile，并返回 rolledBack。
 */
export async function installPlugin(options = {}) {
  const home = resolveHome(options.home)
  const profileName = options.profile ?? defaultProfile(home)
  const profile = resolveProfile(home, profileName)
  const pkgFile = profilePackageJson(profile.dir)

  if (!fs.existsSync(pkgFile)) {
    throw new Error(`Profile not found: ${profile.dir}`)
  }

  const host = detectDshVersion({ ...options, home, profile: profileName })
  if (!host.version) {
    throw new Error('Cannot detect the DSH version. Pass --dsh-version <version> or --app <path-to-DSH>.')
  }

  const inspected = await inspectPlugin({
    profileDir: profile.dir,
    spec: options.spec,
    runCommand: options.runCommand,
  })
  const compatibility = evaluateCompatibility(inspected.manifest, host, profile.dir)

  const result = {
    ok: false,
    dryRun: options.dryRun === true,
    profile: profileName,
    profileDir: profile.dir,
    host,
    plugin: { name: inspected.name, version: inspected.version },
    compatibility,
    backup: null,
    installed: false,
    bundles: [],
    warnings: [],
  }

  if (result.dryRun) return result
  if (compatibility.status === 'blocked' && !options.force) {
    result.error = 'Plugin is not compatible with this DSH version. Re-run with --force to install anyway.'
    return result
  }
  if (compatibility.status === 'blocked') {
    result.warnings.push('installed despite compatibility failure (--force)')
  }

  const beforeManifest = readJsonSync(pkgFile)
  const hadPackage = Boolean(
    readJsonSync(path.join(profile.dir, 'node_modules', inspected.name, 'package.json')),
  )
  const backup = await createBackup(home, [
    pkgFile,
    profilePatch(profile.dir),
    path.join(profile.dir, 'pnpm-lock.yaml'),
    path.join(profile.dir, 'package-lock.json'),
  ])
  result.backup = backup.dir

  const trackedCoexist = await trackCoexistPlugin(profile.dir, beforeManifest)
  if (trackedCoexist) await writeJson(pkgFile, beforeManifest)
  const snapshot = snapshotNodeModules(profile.dir)

  try {
    const local = inspected.source === 'path'
    let spec = options.spec
    let localSpec = null
    if (local) {
      const staged = resolveInside(path.join(profile.dir, '.dsh-coexist', 'plugins'), inspected.name)
      await copyDir(inspected.dir, staged)
      if (inspected.name === 'dsh-coexist-plugin') {
        const cli = await stageLocalCli(profile.dir, inspected.dir)
        if (cli) await rewriteDependency(path.join(staged, 'package.json'), CLI_PACKAGE, cli.rel)
      }
      localSpec = `file:${path.relative(profile.dir, staged).split(path.sep).join('/')}`
      spec = localSpec
    }

    const runner = options.runCommand ?? defaultRunCommand
    const ran = await tryRun(runner, managerAttempts(spec, host.appExe, 'add'), profile.dir)

    if (!ran.ok) {
      const present = verifyPluginDir(profile.dir, inspected.name)
      if (present.ok) {
        // pnpm 11 在忽略 build scripts 时会以非 0 退出，但依赖已经装好。
        result.packageManager = ran.pm ?? 'package-manager (non-zero exit)'
        result.warnings.push(
          `package manager exited non-zero but the package is installed: ${ran.errors.join(' | ')}`,
        )
      } else if (!local) {
        throw new Error(`Package manager failed: ${ran.errors.join(' | ')}`)
      } else {
        // 本地插件没有依赖：包管理器不可用时直接复制进 node_modules。
        await copyDir(inspected.dir, resolveInside(path.join(profile.dir, 'node_modules'), inspected.name))
        if (inspected.name === 'dsh-coexist-plugin') {
          const cli = await stageLocalCli(profile.dir, inspected.dir)
          if (cli) {
            await copyDir(cli.dir, path.join(profile.dir, 'node_modules', CLI_PACKAGE))
            await rewriteDependency(
              path.join(profile.dir, 'node_modules', inspected.name, 'package.json'),
              CLI_PACKAGE,
              cli.rel,
            )
          }
        }
        if (ran.errors.length > 0) {
          result.warnings.push(`package manager unavailable, used local copy: ${ran.errors.join(' | ')}`)
        }
      }
    } else {
      result.packageManager = ran.pm
    }

    const restoredPackages = await restorePrunedPackages(profile.dir, snapshot)
    if (restoredPackages.length > 0) {
      result.restoredPackages = restoredPackages
      result.warnings.push(
        `restored packages pruned by the package manager: ${restoredPackages.join(', ')}`,
      )
    }

    const manifest = readJsonSync(pkgFile)
    if (!manifest) throw new Error(`Broken profile package.json: ${pkgFile}`)
    manifest.dependencies ??= {}
    if (!manifest.dependencies[inspected.name]) {
      manifest.dependencies[inspected.name] = localSpec ?? inspected.version ?? 'latest'
    }
    ensureBundle(manifest, inspected.name)
    await writeJson(pkgFile, manifest)

    const verified = verifyPluginDir(profile.dir, inspected.name)
    if (!verified.ok) throw new Error(verified.error)
    result.warnings.push(...verified.warnings)

    if (options.dumpConfig !== false) {
      const dump = await dumpConfig({ home, profile: profileName, dshBin: options.dshBin })
      if (dump.ok) {
        result.dumpConfig = { ok: true, bytes: dump.stdout?.length ?? 0 }
      } else if (/not found|ENOENT/i.test(dump.error ?? '')) {
        result.dumpConfig = { ok: false, skipped: true, error: dump.error }
      } else {
        result.dumpConfig = { ok: false, error: dump.error }
        result.warnings.push(`dump-config check failed: ${dump.error}`)
      }
    }

    result.installed = true
    result.ok = true
    result.depAdded = !beforeManifest?.dependencies?.[inspected.name]
    result.bundles = manifest.dsh.profile.bundles
    return result
  } catch (err) {
    const restored = await restoreBackupFiles(backup)
    const restoredPackages = await restorePrunedPackages(profile.dir, snapshot)
    if (restoredPackages.length > 0) result.restoredPackages = restoredPackages
    if (!hadPackage) {
      await fsp
        .rm(path.join(profile.dir, 'node_modules', inspected.name), { recursive: true, force: true })
        .catch(() => {})
    }
    result.error = err.message
    result.rolledBack = true
    result.restored = restored
    return result
  }
}

/** 卸载插件：备份 → 从 bundles/dependencies 移除 → 尽力删除包目录。 */
export async function uninstallPlugin(options = {}) {
  const home = resolveHome(options.home)
  const profileName = options.profile ?? defaultProfile(home)
  const profile = resolveProfile(home, profileName)
  const pkgFile = profilePackageJson(profile.dir)
  const manifest = readJsonSync(pkgFile)
  if (!manifest) throw new Error(`Profile not found: ${profile.dir}`)

  const name = assertSafePackageName(options.spec)
  const backup = await createBackup(home, [
    pkgFile,
    profilePatch(profile.dir),
    path.join(profile.dir, 'pnpm-lock.yaml'),
    path.join(profile.dir, 'package-lock.json'),
  ])
  const result = { ok: true, profile: profileName, plugin: name, backup: backup.dir, removed: [] }
  const snapshot = snapshotNodeModules(profile.dir)

  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    manifest.dsh.profile.bundles = bundles.filter((item) => item !== name)
    if (manifest.dsh.profile.bundles.length !== bundles.length) result.removed.push('bundles')
  }
  if (manifest.dependencies?.[name]) {
    delete manifest.dependencies[name]
    result.removed.push('dependencies')
  }
  await writeJson(pkgFile, manifest)

  const runner = options.runCommand ?? defaultRunCommand
  const attempts = managerAttempts(name, null, 'remove')
  const ran = await tryRun(runner, attempts, profile.dir)
  await fsp
    .rm(resolveInside(path.join(profile.dir, 'node_modules'), name), { recursive: true, force: true })
    .catch(() => {})
  const restoredPackages = await restorePrunedPackages(
    profile.dir,
    [...snapshot].filter((item) => item !== name),
  )
  if (restoredPackages.length > 0) {
    result.restoredPackages = restoredPackages
    result.warnings ??= []
    result.warnings.push(
      `restored packages pruned by the package manager: ${restoredPackages.join(', ')}`,
    )
  }
  result.packageManager = ran.ok ? ran.pm : null
  if (!ran.ok) {
    result.warnings ??= []
    result.warnings.push('package manager unavailable; removed the package directory only')
  }
  result.cleaned = await cleanupInstallArtifacts(profile.dir, name, home, options)
  result.purged = options.purge === true
  return result
}

/**
 * rollback 恢复 package.json/lockfile 后，node_modules 里被 prune 的依赖需要重装。
 * 只做 best-effort：包管理器不可用时返回错误，不阻断 rollback。
 */
export async function reinstallDependencies(options = {}) {
  const home = resolveHome(options.home)
  const profileName = options.profile ?? defaultProfile(home)
  const profile = resolveProfile(home, profileName)
  const host = detectDshVersion({ ...options, home, profile: profileName })
  const runner = options.runCommand ?? defaultRunCommand

  const attempts = []
  const bundled = resolveBundledPnpm(host.appExe)
  if (bundled) {
    attempts.push({
      name: 'pnpm(bundled)',
      file: bundled.file,
      prefix: bundled.prefix,
      args: ['install', '--config.strictDepBuilds=false'],
    })
  }
  const npm = npmAttempt(['install', '--no-audit', '--no-fund'])
  if (npm) attempts.push(npm)

  const ran = await tryRun(runner, attempts, profile.dir)
  return {
    ok: ran.ok,
    profile: profileName,
    profileDir: profile.dir,
    packageManager: ran.ok ? ran.pm : null,
    errors: ran.ok ? [] : ran.errors,
  }
}

/**
 * 安装一个普通依赖（例如缺失的 peer），不加入 dsh.profile.bundles。
 * 失败时恢复 package.json 和 lockfile；node_modules 里的新文件可能残留，需要时重装。
 */
export async function installDependency(options = {}) {
  const home = resolveHome(options.home)
  const profileName = options.profile ?? defaultProfile(home)
  const profile = resolveProfile(home, profileName)
  const pkgFile = profilePackageJson(profile.dir)
  if (!fs.existsSync(pkgFile)) throw new Error(`Profile not found: ${profile.dir}`)

  const name = assertSafePackageName(options.name)
  const version = options.version == null ? null : String(options.version).trim()
  if (version && !/^[0-9]+(?:\.[0-9]+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid dependency version: ${version}`)
  }

  const spec = version ? `${name}@${version}` : name
  const host = detectDshVersion({ ...options, home, profile: profileName })
  const backup = await createBackup(home, [
    pkgFile,
    path.join(profile.dir, 'pnpm-lock.yaml'),
    path.join(profile.dir, 'package-lock.json'),
  ])
  const runner = options.runCommand ?? defaultRunCommand
  const ran = await tryRun(runner, managerAttempts(spec, host.appExe, 'add'), profile.dir)
  if (!ran.ok) {
    await rollbackById(home, path.basename(backup.dir))
    return {
      ok: false,
      error: `Package manager failed: ${ran.errors.join(' | ')}`,
      name,
      spec,
      backup: backup.dir,
      rolledBack: true,
    }
  }

  return {
    ok: true,
    name,
    spec,
    version,
    backup: backup.dir,
    packageManager: ran.pm,
    warning: 'node_modules may keep files from the failed attempt; run install again if the package is inconsistent',
  }
}

/**
 * 版本兼容矩阵：宿主版本 + 每个已安装/已启用插件的引擎与 peer 检查结果。
 * N 个插件共用同一套规则，不假设只有两个。
 */
export async function buildMatrix(options = {}) {
  const home = resolveHome(options.home)
  const profileName = options.profile ?? defaultProfile(home)
  const profile = resolveProfile(home, profileName)
  const manifest = readJsonSync(profilePackageJson(profile.dir))
  if (!manifest) throw new Error(`Profile not found: ${profile.dir}`)

  const host = detectDshVersion({ ...options, home, profile: profileName })
  const names = new Set([
    ...(manifest.dsh?.profile?.bundles ?? []),
    ...Object.keys(manifest.dependencies ?? {}),
  ])

  const rows = []
  for (const name of [...names].sort()) {
    const installed = readInstalledManifest(profile.dir, name)
    if (!installed) {
      const hostVersion = name.startsWith('@deepseek-ai/')
        ? readHostPackageVersion(name, host, profile.dir)
        : null
      if (hostVersion) {
        rows.push({ name, installed: true, version: hostVersion, status: 'host', checks: [] })
      } else {
        rows.push({ name, installed: false, status: 'missing', checks: [] })
      }
      continue
    }
    const compatibility = evaluateCompatibility(installed, host, profile.dir)
    rows.push({
      name,
      installed: true,
      version: installed.version,
      status: compatibility.status,
      checks: compatibility.checks,
    })
  }

  return { profile: profileName, profileDir: profile.dir, host, rows }
}
