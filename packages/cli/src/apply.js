import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { createBackup } from './backup.js'
import { auditFile } from './paths.js'

async function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, content, 'utf8')
  try {
    await fs.rename(tmp, file)
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EPERM') {
      await fs.rm(file, { force: true })
      await fs.rename(tmp, file)
      return
    }
    await fs.rm(tmp, { force: true })
    throw err
  }
}

async function pathExists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export function renameNthLoaderId(text, oldId, newId, occurrence = 1) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  let count = 0

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*-\s+id:\s*)(["']?)([^"'\s#]+)\2(\s*(?:#.*)?)$/)
    if (!match || match[3] !== oldId) continue
    count += 1
    if (count !== occurrence) continue
    lines[index] = `${match[1]}${match[2]}${newId}${match[2]}${match[4]}`
    return { ok: true, text: lines.join(eol) }
  }

  return { ok: false, text }
}

/** 在指定 id 的 patch 行块内把 port: oldPort 改成 newPort，保留缩进与注释。 */
export function replacePortInRow(text, id, oldPort, newPort) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const idRe = /^(\s*-\s+id:\s*)(["']?)([^"'\s#]+)\2(\s*(?:#.*)?)$/

  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(idRe)
    if (match && match[3] === id) {
      start = index
      break
    }
  }
  if (start === -1) return { ok: false, text }

  const startIndent = (lines[start].match(/^\s*/) ?? [''])[0].length
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const dash = lines[index].match(/^(\s*)-\s/)
    if (dash && dash[1].length <= startIndent) {
      end = index
      break
    }
  }

  const portRe = new RegExp(`(\\bport:\\s*)${oldPort}\\b`)
  for (let index = start; index < end; index += 1) {
    if (!portRe.test(lines[index])) continue
    lines[index] = lines[index].replace(portRe, `$1${newPort}`)
    return { ok: true, text: lines.join(eol) }
  }

  return { ok: false, text }
}

export async function applyPlan({ home, graph, plan }) {
  const files = new Set()
  for (const action of plan.actions) {
    if (
      action.kind === 'rename-loader-id' ||
      action.kind === 'dedupe-bundles' ||
      action.kind === 'change-port' ||
      action.kind === 'append-patch' ||
      action.kind === 'peer-override' ||
      action.kind === 'disable-loader-row' ||
      action.kind === 'clone-loader-row'
    ) {
      files.add(action.file)
    }
  }

  if (files.size === 0) {
    return { applied: [], backup: null }
  }

  const backup = await createBackup(home, [...files])
  const applied = []

  const renamesByFile = new Map()
  for (const action of plan.actions) {
    if (action.kind !== 'rename-loader-id') continue
    const list = renamesByFile.get(action.file) ?? []
    list.push(action)
    renamesByFile.set(action.file, list)
  }

  for (const [file, actions] of renamesByFile) {
    let text = await fs.readFile(file, 'utf8')
    const descending = [...actions].sort((a, b) => b.occurrence - a.occurrence)

    for (const action of descending) {
      const result = renameNthLoaderId(text, action.oldId, action.newId, action.occurrence)
      if (!result.ok) {
        throw new Error(
          `Loader id "${action.oldId}" occurrence ${action.occurrence} not found in ${file}`,
        )
      }
      text = result.text
      applied.push({ ...action, file })
    }

    await atomicWrite(file, text)
  }

  const portActionsByFile = new Map()
  for (const action of plan.actions) {
    if (action.kind !== 'change-port') continue
    const list = portActionsByFile.get(action.file) ?? []
    list.push(action)
    portActionsByFile.set(action.file, list)
  }

  for (const [file, actions] of portActionsByFile) {
    let text = await fs.readFile(file, 'utf8')
    for (const action of actions) {
      const result = replacePortInRow(text, action.id, action.oldPort, action.newPort)
      if (!result.ok) {
        throw new Error(
          `Port ${action.oldPort} for "${action.id}" not found in ${file}`,
        )
      }
      text = result.text
      applied.push({ ...action, file })
    }
    await atomicWrite(file, text)
  }

  const appendActionsByFile = new Map()
  for (const action of plan.actions) {
    if (
      action.kind !== 'append-patch' &&
      action.kind !== 'disable-loader-row' &&
      action.kind !== 'clone-loader-row'
    ) {
      continue
    }
    const list = appendActionsByFile.get(action.file) ?? []
    list.push(action)
    appendActionsByFile.set(action.file, list)
  }

  for (const [file, actions] of appendActionsByFile) {
    let existing = ''
    try {
      existing = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const body = actions
      .map((action) => {
        let yaml
        let label
        if (action.kind === 'disable-loader-row') {
          yaml = YAML.stringify([{ replace: [{ id: action.oldId, disabled: true }] }])
          label = `disable loader row ${action.oldId}`
        } else if (action.kind === 'clone-loader-row') {
          const row = {
            id: action.newId,
            ...(action.name ? { name: action.name } : {}),
            ...(action.config !== undefined ? { config: action.config } : {}),
            ...(action.disabled !== undefined ? { disabled: action.disabled } : {}),
          }
          yaml = YAML.stringify([{ insert: [row] }])
          label = `clone loader row ${action.oldId} -> ${action.newId}`
        } else {
          yaml = action.yaml
          label = `${action.reason} ${action.targetId}`
        }
        return `# dsh-coexist: ${label}\n${yaml.trimEnd()}`
      })
      .join('\n\n')
    const next = `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${body}\n`
    await atomicWrite(file, next)
    for (const action of actions) applied.push({ ...action, file })
  }

  const peerActionsByFile = new Map()
  for (const action of plan.actions) {
    if (action.kind !== 'peer-override') continue
    const list = peerActionsByFile.get(action.file) ?? []
    list.push(action)
    peerActionsByFile.set(action.file, list)
  }

  for (const [file, actions] of peerActionsByFile) {
    const dir = path.dirname(file)
    const usePnpm =
      (await pathExists(path.join(dir, 'pnpm-lock.yaml'))) ||
      (await pathExists(path.join(dir, 'pnpm-workspace.yaml')))
    const packageJson = JSON.parse(await fs.readFile(file, 'utf8'))
    const target = usePnpm ? (packageJson.pnpm ??= {}) : packageJson
    target.overrides ??= {}

    for (const action of actions) {
      target.overrides[action.dep] = action.version
      applied.push({ ...action, file, manager: usePnpm ? 'pnpm' : 'npm' })
    }

    await atomicWrite(file, `${JSON.stringify(packageJson, null, 2)}\n`)
  }

  for (const action of plan.actions) {
    if (action.kind !== 'dedupe-bundles') continue
    const packageJson = JSON.parse(await fs.readFile(action.file, 'utf8'))
    const bundles = packageJson?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) continue

    const seen = new Set()
    packageJson.dsh.profile.bundles = bundles.filter((bundle) => {
      if (seen.has(bundle)) return false
      seen.add(bundle)
      return true
    })

    await atomicWrite(action.file, `${JSON.stringify(packageJson, null, 2)}\n`)
    applied.push({ ...action, file: action.file })
  }

  await fs.mkdir(path.dirname(auditFile(home)), { recursive: true })
  await fs.appendFile(
    auditFile(home),
    `${JSON.stringify({ at: new Date().toISOString(), applied, backup: backup.dir })}\n`,
  )

  return { applied, backup: backup.dir }
}
