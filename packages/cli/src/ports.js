import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 默认只允许结束这些进程；其它进程需要 --force。 */
const DEFAULT_ALLOWED_PROCESSES = new Set(['node.exe', 'dsh.exe', 'dsh next.exe', 'dsh-next.exe'])

/** 解析 tasklist /FO CSV /NH 的输出：`"node.exe","1234","Console","1","12,345 K"`。 */
export function parseTasklistCsv(text) {
  const owners = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^"([^"]*)","(\d+)"/)
    if (!match) continue
    owners.set(Number(match[2]), match[1])
  }
  return owners
}

async function inspectProcessOwners(pids, runCommand) {
  if (pids.length === 0) return new Map()
  const runner = runCommand ?? execFileAsync
  const owners = new Map()
  for (const pid of pids) {
    try {
      const { stdout } = await runner('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
      })
      const parsed = parseTasklistCsv(stdout)
      const name = parsed.get(pid)
      if (name) owners.set(pid, name)
    } catch {
      // 查不到身份就按未知处理，默认不杀。
    }
  }
  return owners
}

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
 * 只结束 node.exe / DSH 相关进程；其它进程默认跳过，需要 force=true。
 * 返回 pids / owners / killed / skipped / errors，调用方负责展示。
 */
export async function freePort(port, options = {}) {
  const found = await findPortPids(port, options.runCommand)
  if (!found.ok) return { ...found, killed: [], skipped: [], owners: [] }

  const owners = await inspectProcessOwners(found.pids, options.runCommand)
  const ownerList = [...owners].map(([pid, name]) => ({ pid, name }))
  const allowed = options.allowProcesses ?? DEFAULT_ALLOWED_PROCESSES

  if (options.yes !== true) {
    return { ...found, owners: ownerList, killed: [], skipped: [], dryRun: true }
  }

  const killed = []
  const skipped = []
  const errors = []
  for (const pid of found.pids) {
    const name = owners.get(pid)
    const isAllowed = typeof name === 'string' && allowed.has(name.toLowerCase())
    if (!isAllowed && options.force !== true) {
      skipped.push({
        pid,
        name: name ?? null,
        reason: name ? 'not a DSH process' : 'process name unknown',
      })
      continue
    }
    try {
      await (options.runCommand ?? execFileAsync)('taskkill', ['/PID', String(pid), '/F'], {
        windowsHide: true,
      })
      killed.push(pid)
    } catch (error) {
      errors.push({ pid, error: error.message })
    }
  }
  return { ...found, owners: ownerList, killed, skipped, errors }
}
