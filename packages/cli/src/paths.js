import os from 'node:os'
import path from 'node:path'

export function resolveHome(home) {
  return path.resolve(home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
}

export function resolveProfile(home, profile = 'web') {
  return {
    home,
    profile,
    dir: path.join(home, 'profiles', profile),
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
