import fs from 'node:fs/promises'
import YAML from 'yaml'

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function flattenPatch(doc) {
  const rows = []
  if (!Array.isArray(doc)) return rows

  for (const item of doc) {
    if (!item || typeof item !== 'object') continue

    const operation = Array.isArray(item.insert) || item.insert
      ? 'insert'
      : Array.isArray(item.replace) || item.replace
        ? 'replace'
        : null

    if (operation) {
      const list = operation === 'insert' ? item.insert : item.replace
      const items = Array.isArray(list) ? list : [list]
      for (const row of items) {
        if (row && typeof row === 'object') {
          rows.push({ op: operation, ...row })
        }
      }
      continue
    }

    if (typeof item.id === 'string') {
      rows.push({ op: 'row', ...item })
    }
  }

  return rows
}

export async function readPatch(file) {
  const text = await readText(file)
  if (text == null) {
    return { file, exists: false, text: '', rows: [] }
  }

  let doc
  try {
    doc = YAML.parse(text)
  } catch (err) {
    throw new Error(`Failed to parse YAML: ${file}: ${err.message}`)
  }

  return { file, exists: true, text, rows: flattenPatch(doc) }
}
