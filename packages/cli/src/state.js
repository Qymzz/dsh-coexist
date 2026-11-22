import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { graphFile, plansDir, stateFile } from './paths.js'

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
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

export function planIdFor(plan) {
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify(plan.actions ?? []))
    .digest('hex')
    .slice(0, 8)
  return `plan-${Date.now().toString(36)}-${hash}`
}

export async function saveGraph(home, graph) {
  const file = graphFile(home)
  await writeJson(file, {
    generatedAt: new Date().toISOString(),
    home: graph.home,
    profile: graph.profile,
    bundles: graph.bundles,
    conflicts: graph.conflicts,
    logFile: graph.logFile,
    logIssues: graph.logIssues,
  })
  return file
}

export async function readGraph(home) {
  return readJson(graphFile(home))
}

export function validateState(state) {
  const errors = []
  if (!state || typeof state !== 'object') errors.push('state must be an object')
  else {
    if (state.version !== 1) errors.push('state.version must be 1')
    if (state.profile !== undefined && (typeof state.profile !== 'string' || state.profile.length === 0)) {
      errors.push('state.profile must be a non-empty string when set')
    }
    if (state.plan !== undefined) {
      if (!state.plan || typeof state.plan !== 'object') {
        errors.push('state.plan must be an object')
      } else if (state.plan.actions !== undefined && !Array.isArray(state.plan.actions)) {
        errors.push('state.plan.actions must be an array when set')
      } else if (state.plan.id === undefined && state.plan.actions === undefined) {
        errors.push('state.plan must include id or actions')
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

export async function readState(home) {
  const file = stateFile(home)
  const state = await readJson(file)
  if (!state) return { file, exists: false, state: null, validation: { ok: true, errors: [] } }
  return { file, exists: true, state, validation: validateState(state) }
}

export async function writeState(home, patch) {
  const current = (await readState(home)).state ?? { version: 1 }
  const next = {
    ...current,
    ...patch,
    version: 1,
    updatedAt: new Date().toISOString(),
  }
  const validation = validateState(next)
  if (!validation.ok) {
    throw new Error(`invalid coexist state: ${validation.errors.join('; ')}`)
  }
  const file = stateFile(home)
  await writeJson(file, next)
  return { file, state: next }
}

export async function savePlan(home, plan) {
  const stored = {
    ...plan,
    id: plan.id ?? planIdFor(plan),
    createdAt: plan.createdAt ?? new Date().toISOString(),
  }
  const file = path.join(plansDir(home), `${stored.id}.json`)
  await writeJson(file, stored)
  await writeState(home, { plan: { id: stored.id, createdAt: stored.createdAt } })
  return { file, plan: stored }
}

export async function loadPlan(home, id) {
  if (!id) {
    const state = (await readState(home)).state
    id = state?.plan?.id
    if (!id) return null
  }
  const file = path.join(plansDir(home), `${id}.json`)
  const plan = await readJson(file)
  return plan ? { file, plan } : null
}
