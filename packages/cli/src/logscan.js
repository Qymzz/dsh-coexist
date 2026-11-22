import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_ISSUES = 100

/** 在 $DSH_HOME/logs 里找最近的 .log 文件。 */
export async function findLogFile(home) {
  const dir = path.join(home, 'logs')
  try {
    const names = await fs.readdir(dir)
    const files = []
    for (const name of names) {
      if (!name.endsWith('.log')) continue
      const file = path.join(dir, name)
      const stat = await fs.stat(file).catch(() => null)
      if (stat?.isFile()) files.push({ file, mtime: stat.mtimeMs })
    }
    files.sort((left, right) => right.mtime - left.mtime)
    return files[0]?.file ?? null
  } catch {
    return null
  }
}

function matchLine(line) {
  const service = /service "([^"]+)" has been registered at <([^>]+)>/.exec(line)
  if (service) {
    return {
      type: 'service',
      key: service[1],
      owners: [service[2]],
      detail: line.trim(),
    }
  }

  const tool = /tool "([^"]+)" is already registered/.exec(line)
  if (tool) {
    return {
      type: 'tool',
      key: tool[1],
      owners: [],
      detail: line.trim(),
    }
  }

  const loader = /duplicate loader entry id[^\n]*?["']?([A-Za-z0-9_.-]+)/i.exec(line)
  if (loader) {
    return {
      type: 'loader-entry',
      key: loader[1],
      owners: [],
      detail: line.trim(),
    }
  }

  if (/EADDRINUSE/i.test(line)) {
    const port =
      /address already in use[^\n]*:(\d{2,5})\b/i.exec(line) ??
      /EADDRINUSE[^\n]*:(\d{2,5})\b/i.exec(line) ??
      /port\s+(\d{2,5})\b/i.exec(line)
    return {
      type: 'port',
      key: port ? port[1] : '(unknown)',
      owners: [],
      detail: line.trim(),
    }
  }

  if (/(ERESOLVE|peer dependency|peerDependencies|peer dep)/i.test(line)) {
    return {
      type: 'peer',
      key: '(peer)',
      owners: [],
      detail: line.trim(),
    }
  }

  return null
}

/**
 * 扫描 DSH 运行日志里的已知冲突关键词。
 * 只作为证据展示，不直接生成修复计划。
 */
export async function scanLogs({ home, logFile } = {}) {
  const file = logFile ?? (await findLogFile(home))
  if (!file) return { file: null, issues: [] }

  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return { file, issues: [] }
  }

  if (text.length > MAX_BYTES) text = text.slice(-MAX_BYTES)

  const issues = []
  const seen = new Set()
  const lines = text.split(/\r?\n/)

  for (let index = 0; index < lines.length && issues.length < MAX_ISSUES; index += 1) {
    const issue = matchLine(lines[index])
    if (!issue) continue
    const key = `${issue.type}:${issue.key}:${issue.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    issues.push({ ...issue, file, line: index + 1 })
  }

  return { file, issues }
}
