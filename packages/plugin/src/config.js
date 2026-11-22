import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function coexistConfigFile() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return process.env.DSH_COEXIST_CONFIG ?? path.join(home, 'coexist', 'config.json')
}

export function coexistStateDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'coexist')
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 读取最近一次 check/plan 写入的 state 和 plan，供运行期参考。 */
export function loadRuntimePlan() {
  const dir = coexistStateDir()
  const state = readJsonFile(path.join(dir, 'state.json'))
  if (!state) return { state: null, plan: null }
  const id = state?.plan?.id
  const plan = id ? readJsonFile(path.join(dir, 'plans', `${id}.json`)) : null
  return { state, plan }
}

/**
 * 读取 ~/.dsh/coexist/config.json：
 * {
 *   "hooks":  { "agent/pre-step": { "order": ["plugin-a"], "disable": ["plugin-b"] } },
 *   "routes": { "memory_search": { "by": "args", "match": { "scope": "code" } } }
 * }
 * 文件不存在或格式错误时返回空配置，不影响宿主。
 */
export function loadCoexistConfig() {
  const file = coexistConfigFile()
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return { file, exists: true, value: value && typeof value === 'object' ? value : {} }
  } catch {
    return { file, exists: false, value: {} }
  }
}
