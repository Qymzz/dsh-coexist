import YAML from 'yaml'
import { collectDeclaredPorts } from './detectors.js'
import { profilePatch } from './paths.js'

function isEditableSource(source) {
  return source === 'profile' || source === 'home'
}

function lastEditablePatchLayer(graph) {
  const layers = (graph.patches ?? []).filter((layer) => isEditableSource(layer.source))
  return layers[layers.length - 1] ?? null
}

function nextFreePort(base, used) {
  for (let offset = 1; offset <= 100; offset += 1) {
    const candidate = base + offset
    if (candidate > 65535) break
    if (used.has(candidate)) continue
    return candidate
  }
  return null
}

function manualHint(conflict) {
  switch (conflict.resource.type) {
    case 'patch-override':
      return 'DSH 的 patch 是整行替换；在更后层显式写完整 config，或调整 patch 顺序'
    case 'patch-dangling-replace':
      return 'replace 的目标 id 在更早层不存在；检查拼写，或改成 insert'
    case 'port':
      return '改掉其中一个插件的端口，或先结束占用该端口的进程'
    case 'peer':
      return '对齐已安装版本；显式传入 --allow-peer-override 可写入受控 override（之后需要重新安装）'
    case 'command':
      return '运行期会自动改成 /name__coexistN；也可以在 profile patch 里停用其中一个命令'
    case 'provider':
      return '运行期会把后注册的 provider 改成 provider__coexistN；设置页可能仍共用命名空间'
    case 'ui-slot':
      return 'UI 插槽在浏览器客户端注册，host 插件无法改名；需要停用其中一个或等客户端侧支持'
    case 'file-lock':
      return '文件锁没有统一注册 API；需要改配置、换存储目录或做进程隔离'
    default:
      return null
  }
}

export function buildPlan(graph, options = {}) {
  const actions = []

  for (const conflict of graph.conflicts) {
    if (conflict.severity === 'info') continue

    if (conflict.resource.type === 'loader-entry') {
      const rows = conflict.rows ?? []
      const kept = rows[0]
      if (!kept) continue

      const blocked = rows.slice(1).filter((row) => !isEditableSource(row.source))
      if (blocked.length > 0) {
        const layer = lastEditablePatchLayer(graph)
        const file = layer?.file ?? profilePatch(graph.dir)
        actions.push({
          kind: 'disable-loader-row',
          file,
          oldId: conflict.resource.key,
          owner: blocked[0].name ?? null,
          conflict,
        })
        for (const row of blocked) {
          actions.push({
            kind: 'clone-loader-row',
            file,
            oldId: conflict.resource.key,
            newId: nextId(conflict.resource.key, graph, actions),
            name: row.name ?? null,
            config: row.config,
            disabled: row.disabled,
            owner: row.name ?? null,
            conflict,
          })
        }
      }

      const occurrenceByFile = new Map()
      const blockedSet = new Set(blocked)
      for (const row of rows) {
        const occurrence = (occurrenceByFile.get(row.file) ?? 0) + 1
        occurrenceByFile.set(row.file, occurrence)

        if (row === kept) continue
        if (blockedSet.has(row)) continue

        actions.push({
          kind: 'rename-loader-id',
          file: row.file,
          oldId: conflict.resource.key,
          newId: nextId(conflict.resource.key, graph, actions),
          occurrence,
          owner: row.name,
          kept: kept.name,
        })
      }
    } else if (conflict.resource.type === 'bundle') {
      actions.push({
        kind: 'dedupe-bundles',
        file: graph.packageJsonPath,
        key: conflict.resource.key,
        remove: Math.max(0, conflict.owners.length - 1),
      })
    } else if (conflict.resource.type === 'port') {
      const rows = conflict.rows ?? []
      const editable = rows.filter((row) => row.id && isEditableSource(row.source))
      const busyOnly = (conflict.owners ?? []).includes('其它进程')
      const base = Number(conflict.resource.key)

      if (editable.length === rows.length && editable.length > 0 && Number.isInteger(base)) {
        const used = new Set([
          ...collectDeclaredPorts(graph.rows ?? []).keys(),
          ...(graph.busyPorts ?? []),
        ])
        // 保留第一个声明者，其余全部换端口；单行且被系统占用时直接换它。
        const targets = busyOnly ? editable : editable.slice(1)
        let changed = 0

        for (const target of targets) {
          const newPort = nextFreePort(base, used)
          if (!newPort) break
          used.add(newPort)
          actions.push({
            kind: 'change-port',
            file: target.file,
            id: target.id,
            owner: target.name ?? target.id,
            oldPort: base,
            newPort,
          })
          changed += 1
        }

        if (changed === 0) {
          actions.push({ kind: 'manual', conflict, hint: manualHint(conflict) })
        }
      } else {
        actions.push({ kind: 'manual', conflict, hint: manualHint(conflict) })
      }
    } else if (conflict.resource.type === 'patch-override') {
      const suggested = conflict.suggestedPatch
      const layer = lastEditablePatchLayer(graph)

      if (suggested && layer) {
        actions.push({
          kind: 'append-patch',
          file: layer.file,
          targetId: suggested.id,
          yaml: YAML.stringify([{ replace: [suggested] }]),
          reason: 'patch-override',
        })
      } else {
        actions.push({ kind: 'manual', conflict, hint: manualHint(conflict) })
      }
    } else if (conflict.resource.type === 'peer') {
      if (options.allowPeerOverride && conflict.suggestedVersion) {
        actions.push({
          kind: 'peer-override',
          file: graph.packageJsonPath,
          dep: conflict.resource.key,
          version: conflict.suggestedVersion,
        })
      } else {
        actions.push({ kind: 'manual', conflict, hint: manualHint(conflict) })
      }
    } else {
      actions.push({
        kind: 'manual',
        conflict,
        hint: manualHint(conflict),
      })
    }
  }

  return {
    home: graph.home,
    profile: graph.profile,
    conflicts: graph.conflicts,
    actions,
  }
}

function nextId(base, graph, actions) {
  const used = new Set(graph.rows.map((row) => row.id).filter(Boolean))
  for (const action of actions) {
    if (action.newId) used.add(action.newId)
  }

  for (const suffix of 'bcdefghijklmnopqrstuvwxyz') {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }

  let index = 2
  while (used.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}
