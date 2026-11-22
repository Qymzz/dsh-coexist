import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { detectProfile } from './ui.js'

const requireFromCleanup = createRequire(import.meta.url)
const PLUGIN_NAME = 'dsh-coexist-plugin'
const CLI_PACKAGE = 'dsh-coexist-cli'

async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

async function removeIfEmpty(dir) {
  try {
    const entries = await fsp.readdir(dir)
    if (entries.length === 0) await fsp.rmdir(dir)
  } catch {
    // 不存在或非空都无需处理。
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 直接调用 CLI 的 desktop.js：它不依赖 yaml，分阶段副本里也能加载。 */
async function loadDesktopModule(profileDir) {
  const candidates = [path.join(profileDir, '.dsh-coexist', 'plugins', CLI_PACKAGE, 'src', 'desktop.js')]
  try {
    const pkgPath = requireFromCleanup.resolve('dsh-coexist-cli/package.json')
    candidates.push(path.join(path.dirname(pkgPath), 'src', 'desktop.js'))
  } catch {
    // 没有依赖副本时只用分阶段副本。
  }
  for (const file of candidates) {
    if (!(await exists(file))) continue
    try {
      return await import(pathToFileURL(file).href)
    } catch {
      // 继续尝试下一个候选。
    }
  }
  return null
}

/**
 * 宿主插件页卸载不会调用 dsh-coexist CLI，因此这里补一套同样的磁盘清理。
 * 只清安装产物，不动 ~/.dsh/coexist 里的备份/报告（那需要 --purge）。
 */
export async function cleanupSelf(home, profileDir, options = {}) {
  const cleaned = []
  const stagedRoot = path.join(profileDir, '.dsh-coexist', 'plugins')
  const legacy = path.join(home, 'coexist', 'desktop')

  // 旧版快捷方式启动器先恢复，再删目录；恢复失败就保留，避免留下坏快捷方式。
  if (await exists(legacy)) {
    const manifest = path.join(legacy, 'manifest.json')
    let restored = false
    if (await exists(manifest)) {
      try {
        const desktop = await loadDesktopModule(profileDir)
        if (desktop?.restoreDesktop) {
          await desktop.restoreDesktop({ home })
          restored = true
        }
      } catch (error) {
        options.log?.(`[coexist] desktop restore failed, keeping launcher: ${error.message}`)
      }
    }
    if (!(await exists(manifest)) || restored) {
      await fsp.rm(legacy, { recursive: true, force: true })
      cleaned.push(legacy)
    }
  }

  for (const name of [PLUGIN_NAME, CLI_PACKAGE]) {
    const dir = path.join(stagedRoot, name)
    if (!(await exists(dir))) continue
    await fsp.rm(dir, { recursive: true, force: true })
    cleaned.push(dir)
  }

  await removeIfEmpty(stagedRoot)
  await removeIfEmpty(path.join(profileDir, '.dsh-coexist'))
  return cleaned
}

/**
 * 包装宿主 `pluginManager.removeBundle`：卸载共存插件成功后清理安装产物。
 * 更新流程内部也会调用 removeBundle，用 updateBundle 的计数避开。
 */
export function installUninstallCleanup(ctx, options = {}) {
  const { home, profile } = detectProfile(ctx, options)
  const profileDir = path.join(home, 'profiles', profile)
  const patched = new WeakSet()
  const restorers = []
  let updating = 0

  const patch = (service) => {
    if (!service || patched.has(service)) return
    const proto = Object.getPrototypeOf(service)
    const target = proto && typeof proto.removeBundle === 'function' ? proto : service
    if (typeof target.removeBundle !== 'function' || target.__coexistUninstallHook) return

    const originalRemove = target.removeBundle
    const originalUpdate = target.updateBundle

    const wrappedRemove = async function (...args) {
      const result = await originalRemove.apply(this, args)
      const name = typeof args[0] === 'string' ? args[0] : args[0]?.name
      const failed = result?.application === 'failed' || result?.application === 'cancelled'
      if (name !== PLUGIN_NAME || updating > 0 || failed) return result

      const manifest = readJson(path.join(profileDir, 'package.json'))
      const stillReferenced =
        (manifest?.dsh?.profile?.bundles ?? []).includes(PLUGIN_NAME) ||
        Object.hasOwn(manifest?.dependencies ?? {}, PLUGIN_NAME)
      if (stillReferenced) return result

      try {
        const cleaned = await cleanupSelf(home, profileDir, options)
        options.log?.(`[coexist] host uninstall cleanup: ${cleaned.join(', ') || 'nothing to clean'}`)
      } catch (error) {
        options.log?.(`[coexist] host uninstall cleanup failed: ${error.message}`)
      }
      return result
    }

    let wrappedUpdate = null
    if (typeof originalUpdate === 'function') {
      wrappedUpdate = async function (...args) {
        updating += 1
        try {
          return await originalUpdate.apply(this, args)
        } finally {
          updating -= 1
        }
      }
    }

    const apply = (holder) => {
      holder.removeBundle = wrappedRemove
      if (wrappedUpdate) holder.updateBundle = wrappedUpdate
    }

    try {
      apply(target)
    } catch {
      try {
        apply(service)
      } catch {
        return
      }
    }

    patched.add(service)
    target.__coexistUninstallHook = true
    options.log?.('[coexist] host uninstall hook active')
    restorers.push(() => {
      try {
        target.removeBundle = originalRemove
        if (originalUpdate) target.updateBundle = originalUpdate
        delete target.__coexistUninstallHook
      } catch {
        // 宿主已经销毁时无需恢复。
      }
    })
  }

  try {
    patch(typeof ctx.get === 'function' ? ctx.get('pluginManager') : ctx.pluginManager)
  } catch {
    // pluginManager 还没就绪时等下面的事件。
  }

  try {
    ctx.on('internal/service', (name, service) => {
      if (name === 'pluginManager') patch(service)
    })
  } catch {
    // 没有事件服务时只能依赖 apply 时的 pluginManager。
  }

  try {
    ctx.effect(
      () => () => {
        for (const restore of restorers.splice(0)) restore()
      },
      'coexist: host uninstall cleanup',
    )
  } catch {
    // 清理钩子失败不影响插件本身。
  }
  return true
}
