import fs from 'node:fs/promises'
import path from 'node:path'
import { backupsDir } from './paths.js'

export async function createBackup(home, files) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(backupsDir(home), stamp)
  await fs.mkdir(dir, { recursive: true })

  const manifest = {
    createdAt: new Date().toISOString(),
    files: [],
  }

  for (const file of files) {
    try {
      const content = await fs.readFile(file)
      const rel = path.relative(home, file)
      if (rel.startsWith('..')) {
        throw new Error(`Refusing to back up a file outside DSH_HOME: ${file}`)
      }
      const dest = path.join(dir, rel)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, content)
      manifest.files.push({ file, rel })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { dir, manifest }
}

export async function latestBackup(home) {
  let entries
  try {
    entries = await fs.readdir(backupsDir(home), { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  if (dirs.length === 0) return null

  const dir = path.join(backupsDir(home), dirs[dirs.length - 1])
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'))
  return { dir, manifest }
}

export async function rollback(home) {
  const latest = await latestBackup(home)
  if (!latest) return { restored: [], backup: null }

  const restored = []
  for (const item of latest.manifest.files) {
    const source = path.join(latest.dir, item.rel)
    await fs.mkdir(path.dirname(item.file), { recursive: true })
    await fs.copyFile(source, item.file)
    restored.push(item.file)
  }

  return { restored, backup: latest.dir }
}

export async function listBackups(home) {
  let entries
  try {
    entries = await fs.readdir(backupsDir(home), { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
}

/** 按备份目录名回滚；id 必须精确匹配，避免误恢复。 */
export async function rollbackById(home, id) {
  const available = await listBackups(home)
  if (!available.includes(id)) {
    return { restored: [], backup: null, error: `backup not found: ${id}`, available }
  }

  const dir = path.join(backupsDir(home), id)
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'))
  const restored = []
  for (const item of manifest.files) {
    const source = path.join(dir, item.rel)
    await fs.mkdir(path.dirname(item.file), { recursive: true })
    await fs.copyFile(source, item.file)
    restored.push(item.file)
  }
  return { restored, backup: dir, available }
}
