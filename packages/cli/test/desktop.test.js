import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  buildLauncherScript,
  buildVbsLauncher,
  desktopPaths,
  parseDesktopArgs,
} from '../src/desktop.js'

test('parseDesktopArgs reads install options', () => {
  const options = parseDesktopArgs([
    'install',
    '--app',
    'C:\\Program Files\\DSH NEXT\\DSH NEXT.exe',
    '--yes',
    '--dry-run',
  ])

  assert.equal(options.action, 'install')
  assert.equal(options.app, 'C:\\Program Files\\DSH NEXT\\DSH NEXT.exe')
  assert.equal(options.yes, true)
  assert.equal(options.dryRun, true)
})

test('desktopPaths points at the stable launcher files', () => {
  const home = path.resolve('/tmp/dsh-home')
  const paths = desktopPaths(home)
  assert.equal(
    paths.preloadPath,
    path.join(home, 'coexist', 'desktop', 'preload', 'preload.mjs'),
  )
  assert.equal(paths.launcherVbs, path.join(home, 'coexist', 'desktop', 'launch.vbs'))
})

test('buildLauncherScript sets NODE_OPTIONS internally', () => {
  const script = buildLauncherScript({
    appExe: 'C:\\Program Files\\DSH NEXT\\DSH NEXT.exe',
    preloadCjsPath: 'C:\\Users\\me\\AppData\\Local\\dsh-coexist\\preload\\preload.cjs',
  })

  assert.match(script, /NODE_OPTIONS=--require "C:\\Users\\me/)
  assert.match(script, /start "" "C:\\Program Files\\DSH NEXT\\DSH NEXT.exe"/)
})

test('buildVbsLauncher sets the process environment without a console', () => {
  const script = buildVbsLauncher({
    appExe: 'C:\\Program Files\\DSH NEXT\\DSH NEXT.exe',
    preloadCjsPath: 'C:\\Users\\me\\AppData\\Local\\dsh-coexist\\preload\\preload.cjs',
  })

  assert.match(script, /WScript\.Shell/)
  assert.match(script, /NODE_OPTIONS/)
  assert.match(script, /DSH NEXT\.exe/)
})
