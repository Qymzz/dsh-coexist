import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function profileDshBin(home, profile) {
  const file = path.join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return fs.existsSync(file) ? { file: process.execPath, prefix: [file] } : null
}

function globalDshBin() {
  const explicit = process.env.DSH_BIN
  if (explicit) return { file: explicit, prefix: [] }
  const candidates = [
    path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(process.env.ProgramFiles ?? '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ]
  const cli = candidates.find((file) => file && fs.existsSync(file))
  return cli ? { file: process.execPath, prefix: [cli] } : null
}

export function resolveDshBin(home, profile) {
  return profileDshBin(home, profile) ?? globalDshBin()
}

/**
 * 调 DSH 自己的 --dump-config 做合并结果预演。
 * 桌面版没有可执行的 dsh CLI 时返回 ok=false，不阻断主流程。
 */
export function dumpConfig({ home, profile, dshBin, timeoutMs = 60_000 } = {}) {
  const target = dshBin ? { file: dshBin, prefix: [] } : resolveDshBin(home, profile)
  if (!target) return Promise.resolve({ ok: false, error: 'dsh CLI not found' })
  if (/\.(cmd|bat)$/i.test(target.file)) {
    return Promise.resolve({
      ok: false,
      error: `Unsupported dsh CLI path (use the .js entry instead of .cmd/.bat): ${target.file}`,
    })
  }

  return new Promise((resolve) => {
    let output = ''
    let errorOutput = ''
    let child
    try {
      child = spawn(target.file, [...target.prefix, '--profile', profile, '--dump-config'], {
        env: { ...process.env, DSH_HOME: home },
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, error: error.message })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      resolve({ ok: false, error: `dump-config timed out after ${timeoutMs}ms`, stdout: output })
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      errorOutput += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true, stdout: output, stderr: errorOutput })
      else resolve({ ok: false, code, error: errorOutput.trim() || `exit ${code}`, stdout: output })
    })
  })
}
