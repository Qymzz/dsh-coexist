import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 从 netstat -ano 输出里提取监听指定端口的 PID。
 * 只认 LISTENING 行，避免把客户端连接误认为占用者。
 */
export function parseNetstat(text, port) {
  const pids = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5) continue
    const local = columns[1]
    const pid = columns[columns.length - 1]
    const localPort = local.slice(local.lastIndexOf(':') + 1)
    if (localPort !== String(port)) continue
    if (/^\d+$/.test(pid)) pids.add(Number(pid))
  }
  return [...pids]
}

export async function findPortPids(port, runCommand = execFileAsync) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'port cleanup is only implemented for Windows', pids: [] }
  }
  try {
    const { stdout } = await runCommand('netstat', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { ok: true, pids: parseNetstat(stdout, port) }
  } catch (error) {
    return { ok: false, error: error.message, pids: [] }
  }
}

/**
 * 显式清理占用端口的进程；必须传 yes=true 才会 kill。
 * 返回 pids / killed / errors，调用方负责展示。
 */
export async function freePort(port, options = {}) {
  const found = await findPortPids(port, options.runCommand)
  if (!found.ok) return { ...found, killed: [] }
  if (options.yes !== true) return { ...found, killed: [], dryRun: true }

  const killed = []
  const errors = []
  for (const pid of found.pids) {
    try {
      await (options.runCommand ?? execFileAsync)('taskkill', ['/PID', String(pid), '/F'], {
        windowsHide: true,
      })
      killed.push(pid)
    } catch (error) {
      errors.push({ pid, error: error.message })
    }
  }
  return { ...found, killed, errors }
}
