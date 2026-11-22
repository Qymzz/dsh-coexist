import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyPlan } from './apply.js'

const MUTATING = new Set([
  'rename-loader-id',
  'dedupe-bundles',
  'change-port',
  'append-patch',
  'peer-override',
  'disable-loader-row',
  'clone-loader-row',
])

function linesOf(text) {
  if (!text) return []
  return text.split(/\r?\n/)
}

/** 简单 LCS 行级 diff；只用于 preview，文件都很小，不做大文件优化。 */
export function diffLines(leftText, rightText) {
  const left = linesOf(leftText)
  const right = linesOf(rightText)
  const rows = left.length
  const cols = right.length

  if (rows * cols > 4_000_000) {
    return [`--- diff too large (${rows}x${cols} lines) ---`]
  }

  const table = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1))
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const out = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      out.push(` ${left[i]}`)
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`-${left[i]}`)
      i += 1
    } else {
      out.push(`+${right[j]}`)
      j += 1
    }
  }
  while (i < rows) {
    out.push(`-${left[i]}`)
    i += 1
  }
  while (j < cols) {
    out.push(`+${right[j]}`)
    j += 1
  }
  return out
}

/**
 * 在临时目录里真实执行一遍计划，再和原文件对比。
 * 不碰用户文件；apply 失败时返回 error，不阻断 plan。
 */
export async function previewPlan({ home, graph, plan }) {
  const touched = [...new Set(plan.actions.map((action) => action.file).filter(Boolean))]
  if (touched.length === 0) return { files: [] }

  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'coexist-preview-'))
  const files = []
  const mapping = new Map()

  try {
    for (const [index, file] of touched.entries()) {
      const tempFile = path.join(tmpHome, 'files', `${index}-${path.basename(file)}`)
      await fs.mkdir(path.dirname(tempFile), { recursive: true })
      let original = ''
      try {
        original = await fs.readFile(file, 'utf8')
        await fs.writeFile(tempFile, original, 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
        await fs.writeFile(tempFile, '', 'utf8')
      }
      mapping.set(file, tempFile)
      files.push({ file, tempFile, original })
    }

    const tempPlan = {
      ...plan,
      actions: plan.actions.map((action) =>
        action.file && mapping.has(action.file)
          ? { ...action, file: mapping.get(action.file) }
          : action,
      ),
    }

    await applyPlan({ home: tmpHome, graph: { ...graph, dir: tmpHome }, plan: tempPlan })

    return {
      files: await Promise.all(
        files.map(async (item) => {
          const updated = await fs.readFile(item.tempFile, 'utf8').catch(() => '')
          const diff = diffLines(item.original, updated).filter((line) => !line.startsWith(' '))
          return { file: item.file, diff }
        }),
      ),
    }
  } catch (error) {
    return { files: [], error: error.message }
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
  }
}
