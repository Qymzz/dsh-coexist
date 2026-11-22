import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { coexistDir, resolveHome } from './paths.js'

const DEFAULT_APP = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Programs',
  'DSH NEXT',
  'DSH NEXT.exe',
)

export const DESKTOP_HELP = `dsh-coexist desktop <install|restore|status|log> [options]

  install   prepare the preload and update existing DSH shortcuts
  restore   restore the shortcuts backed up by install
  status    show the desktop app, shortcuts and launcher state
  log       print the preload log file

Options:
  --app <file>   path to DSH NEXT.exe (default: auto-detect)
  --home <dir>   DSH_HOME (default: $DSH_HOME or ~/.dsh)
  --yes          apply changes (required for install)
  --dry-run      print the plan without writing anything
  -h, --help     show this help`

export function parseDesktopArgs(argv) {
  const options = {
    action: 'status',
    app: null,
    home: null,
    yes: false,
    dryRun: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--app') options.app = argv[++index]
    else if (arg === '--home') options.home = argv[++index]
    else if (arg === '--yes') options.yes = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (!arg.startsWith('-')) options.action = arg
  }

  return options
}

export function findDesktopApp(explicit) {
  const candidates = [explicit, process.env.DSH_DESKTOP_APP, DEFAULT_APP].filter(Boolean)
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (existsSync(resolved)) return resolved
  }
  throw new Error('DSH desktop app not found. Pass --app <path-to-DSH NEXT.exe>.')
}

export function desktopDir(home) {
  return path.join(coexistDir(resolveHome(home)), 'desktop')
}

export function desktopPaths(home) {
  const dir = desktopDir(home)
  const preloadDir = path.join(dir, 'preload')
  return {
    dir,
    preloadDir,
    preloadPath: path.join(preloadDir, 'preload.mjs'),
    preloadCjsPath: path.join(preloadDir, 'preload.cjs'),
    patchPath: path.join(preloadDir, 'src', 'preload', 'patch.js'),
    launcherCmd: path.join(dir, 'launch.cmd'),
    launcherVbs: path.join(dir, 'launch.vbs'),
    manifest: path.join(dir, 'manifest.json'),
    logPath: path.join(dir, 'preload.log'),
  }
}

export function buildLauncherScript({ appExe, preloadCjsPath }) {
  return [
    '@echo off',
    'setlocal',
    `set NODE_OPTIONS=--require "${preloadCjsPath}"`,
    `start "" "${appExe}"`,
    'exit /b 0',
    '',
  ].join('\r\n')
}

export function buildVbsLauncher({ appExe, preloadCjsPath }) {
  const escaped = preloadCjsPath.replace(/"/g, '""')
  return [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Environment("PROCESS")("NODE_OPTIONS") = "--require ""${escaped}"""`,
    `shell.Run """${appExe}""", 1, False`,
    '',
  ].join('\r\n')
}

function powershell(script) {
  const wrapped = `$ProgressPreference = 'SilentlyContinue'\n${script}`
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8' },
  ).trim()
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

export function listDshShortcuts(appExe, launcherVbs) {
  const script = `
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$dirs = @([Environment]::GetFolderPath('Desktop'))
if ($env:APPDATA) {
  $dirs += (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs')
  $dirs += (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
}
if ($env:PUBLIC) { $dirs += (Join-Path $env:PUBLIC 'Desktop') }
$items = @()
foreach ($dir in $dirs) {
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem $dir -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    $s = $shell.CreateShortcut($_.FullName)
    $items += [pscustomobject]@{
      Path = $_.FullName
      TargetPath = $s.TargetPath
      Arguments = $s.Arguments
      IconLocation = $s.IconLocation
      WorkingDirectory = $s.WorkingDirectory
      Description = $s.Description
    }
  }
}
$items | ConvertTo-Json -Depth 5
`
  const text = powershell(script)
  if (!text) return []

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  const list = Array.isArray(parsed) ? parsed : [parsed]
  const target = path.resolve(appExe).toLowerCase()
  const launcher = launcherVbs ? path.resolve(launcherVbs).toLowerCase() : null

  return list.filter((item) => {
    if (!item.TargetPath) return false
    if (path.resolve(item.TargetPath).toLowerCase() === target) return true
    if (launcher && item.Arguments && item.Arguments.toLowerCase().includes(launcher)) return true
    return false
  })
}

export function desktopPath() {
  try {
    const resolved = powershell("[Environment]::GetFolderPath('Desktop')").trim()
    if (resolved) return resolved
  } catch {
    // Fall back to the conventional path.
  }
  return path.join(process.env.USERPROFILE ?? '', 'Desktop')
}

async function prepareLauncher(paths, appExe) {
  await fs.mkdir(path.join(paths.preloadDir, 'src', 'preload'), { recursive: true })
  await fs.copyFile(
    fileURLToPath(new URL('../preload.mjs', import.meta.url)),
    paths.preloadPath,
  )
  await fs.copyFile(
    fileURLToPath(new URL('../preload.cjs', import.meta.url)),
    paths.preloadCjsPath,
  )
  await fs.copyFile(
    fileURLToPath(new URL('./preload/patch.js', import.meta.url)),
    paths.patchPath,
  )

  await fs.writeFile(
    paths.launcherCmd,
    buildLauncherScript({ appExe, preloadCjsPath: paths.preloadCjsPath }),
    'utf8',
  )

  const vbs = buildVbsLauncher({ appExe, preloadCjsPath: paths.preloadCjsPath })
  const bom = Buffer.from([0xff, 0xfe])
  await fs.writeFile(paths.launcherVbs, Buffer.concat([bom, Buffer.from(vbs, 'utf16le')]))
}

export async function desktopStatus({ home }) {
  let appExe = null
  let appError = null
  try {
    appExe = findDesktopApp()
  } catch (err) {
    appError = err.message
  }

  const paths = desktopPaths(home)
  const shortcuts = appExe ? listDshShortcuts(appExe, paths.launcherVbs) : []
  return {
    appExe,
    appError,
    paths,
    shortcuts,
    launcherExists: existsSync(paths.launcherVbs),
    manifestExists: existsSync(paths.manifest),
  }
}

export async function desktopLog({ home }) {
  const paths = desktopPaths(home)
  if (!existsSync(paths.logPath)) {
    return { file: paths.logPath, exists: false, text: '' }
  }
  return {
    file: paths.logPath,
    exists: true,
    text: await fs.readFile(paths.logPath, 'utf8'),
  }
}

export async function installDesktop({ home, app, yes, dryRun }) {
  const appExe = findDesktopApp(app)
  const paths = desktopPaths(home)
  const allShortcuts = listDshShortcuts(appExe, paths.launcherVbs)
  let shortcuts = allShortcuts.filter(
    (shortcut) =>
      !shortcut.Arguments ||
      !shortcut.Arguments.toLowerCase().includes(paths.launcherVbs.toLowerCase()),
  )

  if (allShortcuts.length === 0) {
    shortcuts = [
      {
        Path: path.join(desktopPath(), 'DSH.lnk'),
        TargetPath: appExe,
        Arguments: '',
        IconLocation: `${appExe},0`,
        WorkingDirectory: path.dirname(appExe),
        Description: 'DSH',
        created: true,
      },
    ]
  }

  const plan = {
    appExe,
    paths,
    shortcuts: shortcuts.length > 0 ? shortcuts : allShortcuts,
  }

  if (dryRun || !yes) {
    return { ...plan, applied: false, needsConfirm: !dryRun }
  }

  await prepareLauncher(paths, appExe)

  let existingManifest = null
  if (existsSync(paths.manifest)) {
    try {
      existingManifest = JSON.parse(await fs.readFile(paths.manifest, 'utf8'))
    } catch {
      existingManifest = null
    }
  }

  const wscript = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'wscript.exe',
  )
  const entries = []
  const errors = []
  let backupDir = existingManifest?.backupDir ?? null

  if (shortcuts.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backupDir = path.join(paths.dir, 'backup', stamp)
    await fs.mkdir(backupDir, { recursive: true })

    for (const shortcut of shortcuts) {
      try {
        let backup = null
        if (!shortcut.created) {
          backup = path.join(backupDir, path.basename(shortcut.Path))
          await fs.copyFile(shortcut.Path, backup)
        }

        const script = `
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut(${quote(shortcut.Path)})
$s.TargetPath = ${quote(wscript)}
$s.Arguments = ${quote(`"${paths.launcherVbs}"`)}
$s.IconLocation = ${quote(`${appExe},0`)}
$s.WorkingDirectory = ${quote(path.dirname(appExe))}
$s.Save()
`
        powershell(script)

        entries.push({
          path: shortcut.Path,
          backup,
          created: Boolean(shortcut.created),
          original: {
            targetPath: shortcut.TargetPath,
            arguments: shortcut.Arguments,
            icon: shortcut.IconLocation,
            workingDirectory: shortcut.WorkingDirectory,
            description: shortcut.Description,
          },
        })
      } catch (err) {
        errors.push({ path: shortcut.Path, message: err.message })
      }
    }
  }

  if (entries.length > 0 || !existingManifest) {
    const manifest = {
      createdAt: existingManifest?.createdAt ?? new Date().toISOString(),
      appExe,
      preloadPath: paths.preloadPath,
      launcherCmd: paths.launcherCmd,
      launcherVbs: paths.launcherVbs,
      backupDir,
      entries: [...(existingManifest?.entries ?? []), ...entries],
    }
    await fs.writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  return { ...plan, applied: true, backupDir, entries, errors }
}

export async function restoreDesktop({ home }) {
  const paths = desktopPaths(home)
  if (!existsSync(paths.manifest)) {
    return { restored: [], missing: true }
  }

  const manifest = JSON.parse(await fs.readFile(paths.manifest, 'utf8'))
  const restored = []

  for (const entry of manifest.entries ?? []) {
    if (entry.created) {
      await fs.rm(entry.path, { force: true })
      restored.push({ path: entry.path, action: 'removed' })
      continue
    }
    if (entry.backup && existsSync(entry.backup)) {
      await fs.copyFile(entry.backup, entry.path)
      restored.push({ path: entry.path, action: 'restored' })
    }
  }

  return { restored, backupDir: manifest.backupDir ?? null }
}
