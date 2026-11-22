export function renderGraph(graph) {
  const lines = []
  lines.push(`DSH home: ${graph.home}`)
  lines.push(`Profile: ${graph.profile}`)
  if (graph.hostVersion) {
    lines.push(`Host: ${graph.hostVersion}${graph.hostChanged ? ' (changed since last check)' : ''}`)
  }
  lines.push(`Bundles: ${graph.bundles.length}`)

  const bundlePatches = (graph.bundleInfo ?? []).filter((info) => info.patch)
  if (bundlePatches.length > 0) {
    lines.push(`Bundle patches: ${bundlePatches.length}`)
  }
  const patchErrors = (graph.bundleInfo ?? []).filter((info) => info.patchError)
  if (patchErrors.length > 0) {
    lines.push(`Bundle patches failed to parse: ${patchErrors.length}`)
    for (const info of patchErrors) {
      lines.push(`  - ${info.name}: ${info.patchError}`)
    }
  }
  lines.push(`Patch files: ${graph.patches.map((patch) => patch.file).join(', ') || '(none)'}`)

  const conflicts = graph.conflicts.filter((conflict) => conflict.severity !== 'info')
  const overrides = graph.conflicts.filter((conflict) => conflict.severity === 'info')

  if (conflicts.length === 0) {
    lines.push('')
    lines.push('No coexistence conflicts found.')
  } else {
    lines.push('')
    lines.push(`Conflicts: ${conflicts.length}`)
    conflicts.forEach((conflict, index) => {
      lines.push(`  ${index + 1}. ${conflict.resource.type}: ${conflict.resource.key}`)
      lines.push(`     owners: ${conflict.owners.join(', ')}`)
      if (conflict.detail) lines.push(`     detail: ${conflict.detail}`)
      lines.push(
        `     strategies: ${conflict.strategies.join(', ')} (recommended: ${conflict.recommended})`,
      )
    })
  }

  if (overrides.length > 0) {
    lines.push('')
    lines.push(`Overrides (informational): ${overrides.length}`)
    overrides.forEach((conflict) => {
      lines.push(`  - ${conflict.resource.type}: ${conflict.resource.key}`)
      lines.push(`    ${conflict.detail}`)
    })
  }

  const logIssues = graph.logIssues ?? []
  if (logIssues.length > 0) {
    lines.push('')
    lines.push(`Log evidence: ${logIssues.length} (from ${graph.logFile}, may be historical)`)
    for (const issue of logIssues.slice(0, 10)) {
      lines.push(`  - ${issue.type}: ${issue.key} (line ${issue.line})`)
    }
    if (logIssues.length > 10) {
      lines.push(`  ... and ${logIssues.length - 10} more (see --json)`)
    }
  }

  return lines.join('\n')
}

export function renderPlan(plan) {
  const lines = []
  lines.push(`Repair plan for profile: ${plan.profile ?? 'unknown'}`)
  if (plan.id) lines.push(`Plan: ${plan.id} (${plan.createdAt ?? 'unknown'})`)
  if (plan.dumpConfig) {
    lines.push(
      plan.dumpConfig.ok
        ? `Dump config: ok (${plan.dumpConfig.stdout.length} bytes)`
        : `Dump config: failed (${plan.dumpConfig.error})`,
    )
  }

  if (plan.actions.length === 0) {
    lines.push('No automatic repairs. Nothing to do.')
    return lines.join('\n')
  }

  plan.actions.forEach((action, index) => {
    if (action.kind === 'rename-loader-id') {
      lines.push(
        `  ${index + 1}. rename loader id "${action.oldId}" -> "${action.newId}" in ${action.file}`,
      )
    } else if (action.kind === 'dedupe-bundles') {
      lines.push(`  ${index + 1}. dedupe bundle "${action.key}" in ${action.file}`)
    } else if (action.kind === 'change-port') {
      lines.push(
        `  ${index + 1}. change port ${action.oldPort} -> ${action.newPort} for "${action.id}" in ${action.file}`,
      )
    } else if (action.kind === 'append-patch') {
      lines.push(
        `  ${index + 1}. append merged patch for "${action.targetId}" in ${action.file}`,
      )
    } else if (action.kind === 'peer-override') {
      lines.push(
        `  ${index + 1}. set peer override "${action.dep}" -> ${action.version} in ${action.file}`,
      )
    } else if (action.kind === 'disable-loader-row') {
      lines.push(`  ${index + 1}. disable loader row "${action.oldId}" in ${action.file}`)
    } else if (action.kind === 'clone-loader-row') {
      lines.push(
        `  ${index + 1}. clone loader row "${action.oldId}" -> "${action.newId}" in ${action.file}`,
      )
    } else {
      const type = action.conflict?.resource?.type ?? 'unknown'
      const key = action.conflict?.resource?.key ?? ''
      lines.push(`  ${index + 1}. manual: ${type} ${key}`)
      if (action.conflict?.detail) lines.push(`     ${action.conflict.detail}`)
      if (action.hint) lines.push(`     ${action.hint}`)
    }
  })

  if (plan.preview?.error) {
    lines.push('', `Preview failed: ${plan.preview.error}`)
  } else if (plan.preview?.files?.length) {
    lines.push('', 'Preview:')
    for (const file of plan.preview.files) {
      if (!file.diff?.length) continue
      lines.push(`  ${file.file}`)
      for (const line of file.diff.slice(0, 30)) lines.push(`    ${line}`)
      if (file.diff.length > 30) lines.push(`    ... and ${file.diff.length - 30} more`)
    }
  }

  return lines.join('\n')
}

export function renderApply(result) {
  const lines = []
  if (result.plan?.id) lines.push(`Plan: ${result.plan.id}`)
  lines.push(`Backup: ${result.backup ?? '(none)'}`)

  if (result.applied.length === 0) {
    lines.push('Nothing applied.')
    return lines.join('\n')
  }

  lines.push('Applied:')
  for (const action of result.applied) {
    if (action.kind === 'rename-loader-id') {
      lines.push(`  - renamed "${action.oldId}" -> "${action.newId}" (${action.file})`)
    } else if (action.kind === 'dedupe-bundles') {
      lines.push(`  - deduped "${action.key}" (${action.file})`)
    } else if (action.kind === 'change-port') {
      lines.push(
        `  - changed port ${action.oldPort} -> ${action.newPort} for "${action.id}" (${action.file})`,
      )
    } else if (action.kind === 'append-patch') {
      lines.push(`  - appended merged patch for "${action.targetId}" (${action.file})`)
    } else if (action.kind === 'peer-override') {
      lines.push(
        `  - set peer override "${action.dep}" -> ${action.version} (${action.manager ?? 'npm'})`,
      )
    } else if (action.kind === 'disable-loader-row') {
      lines.push(`  - disabled loader row "${action.oldId}" (${action.file})`)
    } else if (action.kind === 'clone-loader-row') {
      lines.push(
        `  - cloned loader row "${action.oldId}" -> "${action.newId}" (${action.file})`,
      )
    } else {
      lines.push(`  - ${action.kind} (${action.file ?? ''})`)
    }
  }

  if (result.applied.some((action) => action.kind === 'peer-override')) {
    const managers = new Set(
      result.applied
        .filter((action) => action.kind === 'peer-override')
        .map((action) => action.manager ?? 'npm'),
    )
    lines.push('', `Peer overrides written. Reinstall the profile (${[...managers].join('/')} install).`)
  }

  return lines.join('\n')
}

export function renderRollback(result) {
  if (result.error) {
    const lines = [`Rollback failed: ${result.error}`]
    if (result.available?.length) {
      lines.push('Available backups:')
      for (const id of result.available) lines.push(`  - ${id}`)
    }
    return lines.join('\n')
  }
  if (!result.backup) return 'No backup found. Nothing to roll back.'
  const lines = [`Restored from ${result.backup}:`]
  for (const file of result.restored) lines.push(`  - ${file}`)
  if (result.reinstall) {
    lines.push(
      '',
      result.reinstall.ok
        ? `Dependencies reinstalled (${result.reinstall.packageManager}).`
        : `Dependency reinstall failed: ${result.reinstall.errors.join(' | ')}`,
    )
  }
  return lines.join('\n')
}

export function renderList(result) {
  const lines = [
    `Profile: ${result.profile} (${result.dir})`,
    `Bundles: ${result.bundles.length}`,
  ]
  for (const bundle of result.bundles) {
    const patch = bundle.hasPatch ? ' [patch]' : ''
    const version = bundle.version ? `@${bundle.version}` : ''
    lines.push(`  - ${bundle.name}${version}${patch}`)
    if (bundle.patchError) lines.push(`    patch error: ${bundle.patchError}`)
  }

  lines.push('', `Conflicts: ${result.conflicts.length}`)
  for (const conflict of result.conflicts) {
    lines.push(
      `  - [${conflict.severity}] ${conflict.type}: ${conflict.key} (${conflict.owners.join(', ')})`,
    )
  }
  return lines.join('\n')
}

export function renderAudit(result) {
  if (!result.exists) return `No audit log at ${result.file}.`
  if (result.entries.length === 0) return `No audit entries in ${result.file}.`
  const lines = [`Audit: ${result.file}`]
  for (const entry of result.entries) {
    const applied = Array.isArray(entry.applied) ? entry.applied : []
    lines.push(`  - ${entry.at ?? 'unknown'}: ${applied.length} action(s)`)
    if (entry.backup) lines.push(`    backup: ${entry.backup}`)
    for (const action of applied.slice(0, 5)) {
      lines.push(`    ${action.kind}${action.file ? ` (${action.file})` : ''}`)
    }
    if (applied.length > 5) lines.push(`    ... and ${applied.length - 5} more`)
  }
  return lines.join('\n')
}

export function renderBackups(result) {
  if (result.ids.length === 0) return `No backups under ${result.home}.`
  const lines = [`Backups under ${result.home}:`]
  for (const id of result.ids) lines.push(`  - ${id}`)
  return lines.join('\n')
}

export function renderReport(result) {
  if (!result.exists) {
    return [
      `No runtime report at ${result.file}.`,
      'Start DSH with the coexist plugin installed, then run this command again.',
    ].join('\n')
  }

  const report = result.report
  const lines = []
  lines.push(`Runtime report: ${result.file}`)
  lines.push(`Generated: ${report.generatedAt ?? 'unknown'}`)
  lines.push(`Mode: ${report.mode ?? 'alias'}`)
  if (report.plan?.id) {
    lines.push(
      `Runtime plan: ${report.plan.id} (${report.plan.actions ?? 0} actions${
        report.plan.applied ? `, applied ${report.plan.applied.actions ?? 0}` : ''
      })`,
    )
  }
  const caps = report.capabilities ?? {}
  const enabled = Object.entries(caps)
    .filter(([, value]) => value === true)
    .map(([key]) => key)
  if (enabled.length > 0) lines.push(`Capabilities: ${enabled.join(', ')}`)

  const aliases = report.tools?.aliases ?? []
  lines.push(`Tool aliases: ${aliases.length}`)
  for (const alias of aliases) {
    const calls = alias.calls ? ` (calls=${alias.calls})` : ''
    lines.push(`  - ${alias.name} -> ${alias.alias}${calls}`)
  }

  const fallbacks = report.tools?.fallbacks ?? []
  if (fallbacks.length > 0) {
    lines.push(`Fallbacks: ${fallbacks.length}`)
    for (const fallback of fallbacks.slice(-5)) {
      lines.push(`  - ${fallback.tool}: ${fallback.error}`)
    }
  }

  const routes = report.tools?.routes ?? []
  if (routes.length > 0) {
    lines.push(`Routes: ${routes.length}`)
    for (const route of routes.slice(-5)) {
      lines.push(`  - ${route.tool} -> ${route.target} (${route.reason ?? 'rule'})`)
    }
  }

  const stats = Object.entries(report.tools?.stats ?? {})
  if (stats.length > 0) {
    const total = stats.reduce((sum, [, stat]) => sum + stat.calls, 0)
    lines.push(`Tool calls: ${total}`)
    for (const [tool, stat] of stats.sort((a, b) => b[1].calls - a[1].calls).slice(0, 8)) {
      const avg = stat.calls > 0 ? Math.round(stat.totalMs / stat.calls) : 0
      const extra = [
        stat.errors > 0 ? `errors=${stat.errors}` : '',
        stat.blocked > 0 ? `blocked=${stat.blocked}` : '',
      ]
        .filter(Boolean)
        .join(', ')
      lines.push(`  - ${tool}: ${stat.calls} calls, avg ${avg}ms${extra ? ` (${extra})` : ''}`)
    }
  }

  const commandAliases = report.commands?.aliases ?? []
  if (commandAliases.length > 0) {
    lines.push(`Command aliases: ${commandAliases.length}`)
    for (const alias of commandAliases) {
      lines.push(`  - /${alias.name} -> /${alias.alias}`)
    }
  }

  const providerAliases = report.providers?.aliases ?? []
  if (providerAliases.length > 0) {
    lines.push(`Provider aliases: ${providerAliases.length}`)
    for (const alias of providerAliases) {
      lines.push(`  - ${alias.name} -> ${alias.alias}`)
    }
  }

  const providerConflicts = report.providers?.conflicts ?? []
  if (providerConflicts.length > 0) {
    lines.push(`Provider conflicts: ${providerConflicts.length}`)
    for (const conflict of providerConflicts) {
      lines.push(
        `  - ${conflict.name}: ${conflict.resolution ?? 'blocked'}${conflict.message ? ` (${conflict.message})` : ''}`,
      )
    }
  }

  lines.push(`Service conflicts: ${report.serviceConflicts?.length ?? 0}`)
  for (const conflict of report.serviceConflicts ?? []) {
    const resolution =
      conflict.resolution === 'bridged'
        ? ' (bridged)'
        : conflict.resolution === 'isolated'
          ? ' (isolated)'
          : ''
    lines.push(
      `  - ${conflict.service}: ${conflict.existing ?? 'unknown'} vs ${conflict.incoming ?? 'unknown'}${resolution}`,
    )
    if (conflict.suggestion) lines.push(`    ${conflict.suggestion}`)
  }

  const recoveries = report.recoveries ?? []
  if (recoveries.length > 0) {
    lines.push(`Recovery attempts: ${recoveries.length}`)
    for (const item of recoveries) {
      lines.push(
        `  - ${item.plugin}: ${item.state}${item.error ? ` (${item.error})` : ''}`,
      )
    }
  }

  lines.push(`Failed plugins: ${report.failures?.length ?? 0}`)
  for (const failure of report.failures ?? []) {
    const kind = failure.kind ? ` [${failure.kind}]` : ''
    lines.push(`  - ${failure.plugin}${kind}: ${failure.error ?? failure.state}`)
    if (failure.suggestion) lines.push(`    ${failure.suggestion}`)
  }

  lines.push(`Pending plugins: ${report.pending?.length ?? 0}`)
  for (const pending of report.pending ?? []) {
    const missing = pending.missing?.length ? ` missing: ${pending.missing.join(', ')}` : ''
    lines.push(`  - ${pending.plugin} (${pending.state})${missing}`)
    if (pending.suggestion) lines.push(`    ${pending.suggestion}`)
  }
  if (report.pending?.length) {
    lines.push('  (pending may be optional capabilities, not necessarily a failure)')
  }

  const hooks = [...(report.eventHooks ?? [])].sort(
    (left, right) =>
      (right.prepend ?? 0) - (left.prepend ?? 0) ||
      (right.listeners ?? 0) - (left.listeners ?? 0),
  )
  lines.push(`Shared event hooks: ${hooks.length}`)
  for (const hook of hooks.slice(0, 10)) {
    const prepend = hook.prepend ? `, prepend=${hook.prepend}` : ''
    const risk = hook.risk ? ` [${hook.risk}]` : ''
    lines.push(`  - ${hook.event}: ${hook.owners.join(', ')}${prepend}${risk}`)
    if (hook.reason && hook.risk !== 'low') lines.push(`    ${hook.reason}`)
  }
  if (hooks.length > 10) {
    lines.push(`  ... and ${hooks.length - 10} more (see report.json)`)
  }
  if (hooks.length > 0) {
    lines.push('  (Cordis runs every listener; shared hooks are informational)')
  }

  return lines.join('\n')
}

function compatibilityLine(compatibility) {
  if (!compatibility || compatibility.checks.length === 0) return 'unknown (plugin declares no engine/peer range)'
  if (compatibility.status === 'ok') return 'ok'
  const failed = compatibility.checks.filter((check) => check.ok === false)
  if (failed.length > 0) {
    return failed
      .map((check) => `blocked: ${check.name} ${check.range} (host ${check.actual ?? 'unknown'})`)
      .join('; ')
  }
  const unknown = compatibility.checks.filter((check) => check.ok === null)
  return `unknown: ${unknown.map((check) => `${check.name} ${check.range}`).join('; ')}`
}

export function renderInstall(result) {
  const lines = []
  const action = result.dryRun ? 'Would install' : result.ok ? 'Installed' : 'Install failed'
  lines.push(`${action}: ${result.plugin.name}@${result.plugin.version ?? '?'}`)
  lines.push(`Profile: ${result.profile} (${result.profileDir})`)
  lines.push(`Host: ${result.host.version ?? 'unknown'} (${result.host.source ?? 'not detected'})`)
  lines.push(`Compatibility: ${compatibilityLine(result.compatibility)}`)

  if (result.dryRun) return lines.join('\n')

  if (result.error) lines.push(`Error: ${result.error}`)
  if (result.backup) lines.push(`Backup: ${result.backup}`)
  if (result.packageManager) lines.push(`Package manager: ${result.packageManager}`)
  if (result.dumpConfig) {
    const dump = result.dumpConfig
    lines.push(
      `Dump config: ${
        dump.ok
          ? `ok (${dump.bytes} bytes)`
          : dump.skipped
            ? `skipped (${dump.error})`
            : `failed (${dump.error})`
      }`,
    )
  }
  if (result.rolledBack) {
    lines.push(`Rolled back: ${(result.restored ?? []).join(', ') || '(no files)'}`)
  }
  if (result.bundles?.length) lines.push(`Bundles: ${result.bundles.join(', ')}`)
  for (const warning of result.warnings ?? []) lines.push(`Warning: ${warning}`)
  if (result.ok) lines.push('', 'Restart DSH to load the plugin.')
  return lines.join('\n')
}

export function renderUninstall(result) {
  const lines = [`Uninstalled: ${result.plugin}`, `Profile: ${result.profile}`, `Backup: ${result.backup}`]
  lines.push(`Removed: ${result.removed.join(', ') || '(nothing was registered)'}`)
  if (result.packageManager) lines.push(`Package manager: ${result.packageManager}`)
  for (const path of result.cleaned ?? []) lines.push(`Cleaned: ${path}`)
  if (result.purged) lines.push('Purged: ~/.dsh/coexist (backups, reports, config)')
  for (const warning of result.warnings ?? []) lines.push(`Warning: ${warning}`)
  lines.push('', 'Restart DSH to unload the plugin.')
  return lines.join('\n')
}

export function renderMatrix(result) {
  const lines = [
    `Profile: ${result.profile} (${result.profileDir})`,
    `Host: ${result.host.version ?? 'unknown'} (${result.host.source ?? 'not detected'})`,
    '',
  ]
  const rows = result.rows.map((row) => {
    const detail =
      row.status === 'missing'
        ? 'not installed'
        : row.checks.length === 0
          ? 'no declared range'
          : row.checks
              .map((check) => {
                const state = check.ok === true ? 'ok' : check.ok === false ? 'FAIL' : '?'
                return `${check.kind}:${check.name} ${state}`
              })
              .join(', ')
    return { ...row, detail }
  })
  const width = Math.max(8, ...rows.map((row) => row.name.length))
  lines.push(`${'PLUGIN'.padEnd(width)}  ${'VERSION'.padEnd(12)}  STATUS   DETAIL`)
  for (const row of rows) {
    lines.push(
      `${row.name.padEnd(width)}  ${String(row.version ?? '-').padEnd(12)}  ${row.status.padEnd(8)} ${row.detail}`,
    )
  }
  return lines.join('\n')
}

export function renderDesktopPlan(result) {
  const lines = [`DSH app: ${result.appExe}`, `Launcher: ${result.paths.launcherVbs}`, 'Shortcuts:']
  for (const shortcut of result.shortcuts) {
    lines.push(`  - ${shortcut.Path}${shortcut.created ? ' (create)' : ''}`)
  }
  return lines.join('\n')
}

export function renderDesktopInstall(result) {
  const lines = [
    `Installed: ${result.paths.launcherVbs}`,
    `Backup: ${result.backupDir}`,
    'Updated shortcuts:',
  ]
  for (const entry of result.entries) {
    lines.push(`  - ${entry.path}${entry.created ? ' (created)' : ''}`)
  }
  if (result.errors?.length) {
    lines.push('Errors:')
    for (const error of result.errors) lines.push(`  - ${error.path}: ${error.message}`)
  }
  lines.push('', 'Fully quit DSH, then double-click the DSH shortcut.')
  return lines.join('\n')
}

export function renderDesktopRestore(result) {
  if (result.missing) return 'No desktop install manifest found.'
  const lines = [`Restored ${result.restored.length} shortcut(s).`]
  for (const item of result.restored) lines.push(`  - ${item.action}: ${item.path}`)
  return lines.join('\n')
}

export function renderDesktopStatus(result) {
  const lines = []
  lines.push(`DSH app: ${result.appExe ?? `(not found: ${result.appError})`}`)
  lines.push(`Launcher: ${result.launcherExists ? result.paths.launcherVbs : '(not installed)'}`)
  lines.push(`Log: ${result.paths.logPath}`)
  lines.push(`Shortcuts: ${result.shortcuts.length}`)
  for (const shortcut of result.shortcuts) {
    lines.push(`  - ${shortcut.Path} -> ${shortcut.TargetPath}`)
  }
  return lines.join('\n')
}

export function renderDesktopLog(result) {
  if (!result.exists) {
    return [
      `No preload log at ${result.file}.`,
      'Fully quit DSH, then start it from the DSH icon on the Desktop or Start Menu.',
    ].join('\n')
  }
  return result.text
}
