import os from 'node:os'
import path from 'node:path'

export function resolveHome(home) {
  return path.resolve(home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}

/** profile 是目录名，不是路径；拒绝分隔符、`..` 和 shell 元字符。 */
export function assertSafeProfileName(profile) {
  const name = String(profile ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`Invalid profile name: ${JSON.stringify(name)}`)
  }
  return name
}

export function resolveProfile(home, profile = 'web') {
  const name = assertSafeProfileName(profile)
  return {
    home,
    profile: name,
    dir: path.join(home, 'profiles', name),
  }
}

export function profilePackageJson(dir) {
  return path.join(dir, 'package.json')
}

export function profilePatch(dir) {
  return path.join(dir, 'cordis.patch.yml')
}

export function homePatch(home) {
  return path.join(home, 'cordis.patch.yml')
}

export function coexistDir(home) {
  return path.join(home, 'coexist')
}

export function backupsDir(home) {
  return path.join(coexistDir(home), 'backups')
}

export function reportFile(home) {
  return path.join(coexistDir(home), 'report.json')
}

export function auditFile(home) {
  return path.join(coexistDir(home), 'audit.jsonl')
}

export function stateFile(home) {
  return path.join(coexistDir(home), 'state.json')
}

export function graphFile(home) {
  return path.join(coexistDir(home), 'graph.json')
}

export function plansDir(home) {
  return path.join(coexistDir(home), 'plans')
}
