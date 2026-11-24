#!/usr/bin/env node
import {
  runCheck,
  runPlan,
  runApply,
  runRollback,
  runReport,
  runList,
  runAudit,
  runBackups,
  runPrefer,
} from '../src/commands.js'
import {
  renderGraph,
  renderPlan,
  renderApply,
  renderRollback,
  renderReport,
  renderList,
  renderAudit,
  renderBackups,
  renderInstall,
  renderUninstall,
  renderMatrix,
  renderDesktopPlan,
  renderDesktopInstall,
  renderDesktopRestore,
  renderDesktopStatus,
  renderDesktopLog,
} from '../src/report.js'
import { installPlugin, uninstallPlugin, installDependency, buildMatrix } from '../src/installer.js'
import { freePort } from '../src/ports.js'
import { fileURLToPath } from 'node:url'
import { parseRunArgs, runDsh, RUN_HELP } from '../src/launcher.js'
import {
  parseDesktopArgs,
  installDesktop,
  restoreDesktop,
  desktopStatus,
  desktopLog,
  DESKTOP_HELP,
} from '../src/desktop.js'

const HELP = `dsh-coexist <check|plan|apply|rollback|report|list|audit|backups|prefer|free-port|run|desktop|install|uninstall|matrix> [options]

  check      scan the profile and report coexistence conflicts (default)
  plan       print the repair plan without writing anything
  apply      apply the plan (requires --yes)
  rollback   restore the latest backup, or one selected with --id
  report     read the runtime report written by the plugin
  list       list installed bundles and detected resources
  audit      read the local audit log
  backups    list backup ids
  prefer     move a bundle to the front so it keeps the original name on conflicts
  free-port  show or kill the process listening on a port (--yes to kill)
  run        boot DSH with the coexist preload (see: dsh-coexist run --help)
  desktop    install/restore the DSH desktop shortcut wrapper
  install    install a plugin into the profile (auto version check + rollback)
  uninstall  remove a plugin from the profile
  matrix     show host/plugin version compatibility for every installed plugin

Options:
  --home <dir>       DSH_HOME (default: $DSH_HOME or ~/.dsh)
  --profile <name>   profile name (default: desktop when it exists, otherwise web)
  --json             print JSON
  --yes              apply without the dry-run confirmation
  --no-port-scan     skip probing declared ports
  --no-log-scan      skip scanning DSH logs for historical errors
  --no-source-scan   skip scanning plugin sources for command/provider/slot/lock conflicts
  --log <file>       scan a specific log file
  --allow-peer-override  write controlled peer overrides (requires reinstall)
  --app <file>       path to the DSH desktop executable (auto-detected by default)
  --dsh-version <v>  override the detected DSH version
  --self             install the bundled dsh-coexist-plugin
  --force            install even if the version check fails; free-port: also kill non-DSH processes
  --dry-run          for install: check only, write nothing
  --plan <id>        apply a saved plan (default: latest)
  --version <v>      install-peer: version or range to install
  --id <id>          rollback a specific backup id
  --limit <n>        audit entries to show (default 20)
  --dump-config      also run DSH --dump-config as a preflight
  --reinstall        after rollback, reinstall dependencies from the restored lockfile
  --purge            for uninstall: also remove ~/.dsh/coexist (backups, reports, config)
  --no-diff          skip the plan file preview
  -h, --help         show this help
`

function parseArgs(argv) {
  const options = { command: 'check', positional: [] }
  let commandSet = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--home') options.home = argv[++index]
    else if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--json') options.json = true
    else if (arg === '--yes') options.yes = true
    else if (arg === '--no-port-scan') options.scanPorts = false
    else if (arg === '--no-log-scan') options.scanLogs = false
    else if (arg === '--no-source-scan') options.scanSources = false
    else if (arg === '--log') options.logFile = argv[++index]
    else if (arg === '--allow-peer-override') options.allowPeerOverride = true
    else if (arg === '--app') options.app = argv[++index]
    else if (arg === '--dsh-version') options.dshVersion = argv[++index]
    else if (arg === '--self') options.self = true
    else if (arg === '--force') options.force = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--plan') options.planId = argv[++index]
    else if (arg === '--version') options.version = argv[++index]
    else if (arg === '--id') options.id = argv[++index]
    else if (arg === '--limit') options.limit = Number(argv[++index])
    else if (arg === '--dump-config') options.dumpConfig = true
    else if (arg === '--reinstall') options.reinstall = true
    else if (arg === '--purge') options.purge = true
    else if (arg === '--no-diff') options.diff = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (!arg.startsWith('-') && !commandSet) {
      options.command = arg
      commandSet = true
    } else if (!arg.startsWith('-')) options.positional.push(arg)
  }

  return options
}

async function main() {
  if (process.argv[2] === 'run') {
    const runOptions = parseRunArgs(process.argv.slice(3))
    if (runOptions.help) {
      console.log(RUN_HELP)
      return
    }
    const code = await runDsh(runOptions)
    if (typeof code === 'number' && code !== 0) process.exitCode = code
    return
  }

  if (process.argv[2] === 'desktop') {
    const desktopOptions = parseDesktopArgs(process.argv.slice(3))
    if (desktopOptions.help) {
      console.log(DESKTOP_HELP)
      return
    }

    if (desktopOptions.action === 'install') {
      const result = await installDesktop(desktopOptions)
      if (!result.applied) {
        console.log(renderDesktopPlan(result))
        if (result.needsConfirm) {
          console.log('')
          console.log('Dry run only. Re-run with --yes to apply.')
        }
        return
      }
      console.log(renderDesktopInstall(result))
      return
    }

    if (desktopOptions.action === 'restore') {
      console.log(renderDesktopRestore(await restoreDesktop(desktopOptions)))
      return
    }

    if (desktopOptions.action === 'status') {
      console.log(renderDesktopStatus(await desktopStatus(desktopOptions)))
      return
    }

    if (desktopOptions.action === 'log') {
      console.log(renderDesktopLog(await desktopLog(desktopOptions)))
      return
    }

    console.error(`Unknown desktop action: ${desktopOptions.action}`)
    console.log(DESKTOP_HELP)
    process.exitCode = 1
    return
  }

  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(HELP)
    return
  }

  if (options.command === 'check') {
    const { graph } = await runCheck(options)
    console.log(options.json ? JSON.stringify(graph, null, 2) : renderGraph(graph))
    return
  }

  if (options.command === 'plan') {
    const { plan } = await runPlan(options)
    console.log(options.json ? JSON.stringify(plan, null, 2) : renderPlan(plan))
    return
  }

  if (options.command === 'apply') {
    const result = await runApply(options)
    if (result.needsConfirm) {
      console.log(renderPlan(result.plan))
      console.log('')
      console.log('Dry run only. Re-run with --yes to apply.')
      return
    }
    console.log(options.json ? JSON.stringify(result, null, 2) : renderApply(result))
    return
  }

  if (options.command === 'rollback') {
    const result = await runRollback(options)
    console.log(options.json ? JSON.stringify(result, null, 2) : renderRollback(result))
    return
  }

  if (options.command === 'report') {
    const result = await runReport(options)
    console.log(options.json ? JSON.stringify(result, null, 2) : renderReport(result))
    return
  }

  if (options.command === 'list') {
    const result = await runList(options)
    console.log(options.json ? JSON.stringify(result, null, 2) : renderList(result))
    return
  }

  if (options.command === 'audit') {
    const result = await runAudit(options)
    console.log(options.json ? JSON.stringify(result, null, 2) : renderAudit(result))
    return
  }

  if (options.command === 'backups') {
    const result = await runBackups(options)
    console.log(options.json ? JSON.stringify(result, null, 2) : renderBackups(result))
    return
  }

  if (options.command === 'prefer') {
    const result = await runPrefer({ ...options, plugin: options.positional[0] })
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (!result.ok) {
      console.log(`Prefer failed: ${result.error}`)
    } else if (!result.changed) {
      console.log(`${result.plugin} is already first.`)
    } else {
      console.log(`Moved ${result.plugin} to the front. Restart DSH to apply.`)
      console.log(`Backup: ${result.backup}`)
    }
    if (!result.ok) process.exitCode = 1
    return
  }

  if (options.command === 'free-port') {
    const port = Number(options.positional[0])
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error('Usage: dsh-coexist free-port <port> [--yes] [--force]')
      process.exitCode = 1
      return
    }
    const result = await freePort(port, { yes: options.yes, force: options.force })
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (!result.ok) {
      console.log(`Cannot inspect port ${port}: ${result.error}`)
    } else if (result.pids.length === 0) {
      console.log(`Port ${port} is free.`)
    } else if (result.killed.length > 0) {
      console.log(`Killed ${result.killed.length} process(es) on port ${port}: ${result.killed.join(', ')}`)
    } else {
      console.log(`Port ${port} is held by PID(s): ${result.pids.join(', ')}`)
      console.log('Re-run with --yes to kill them.')
    }
    if (result.skipped?.length > 0) {
      console.log(`Skipped ${result.skipped.length} non-DSH process(es):`)
      for (const item of result.skipped) {
        console.log(`  PID ${item.pid}${item.name ? ` (${item.name})` : ''}: ${item.reason}`)
      }
      console.log('Use --force only if you are sure.')
    }
    return
  }

  if (options.command === 'install-peer') {
    const name = options.positional[0]
    if (!name) {
      console.error('Usage: dsh-coexist install-peer <package> [--version <v>] [--home <dir>] [--profile <name>]')
      process.exitCode = 1
      return
    }
    const result = await installDependency({
      home: options.home,
      profile: options.profile,
      name,
      version: options.version,
    })
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (!result.ok) {
      console.error(result.error)
    } else {
      console.log(`Installed ${result.spec} via ${result.packageManager}.`)
      console.log(`Backup: ${result.backup}`)
    }
    if (!result.ok) process.exitCode = 1
    return
  }

  if (options.command === 'install') {
    const spec = options.self
      ? fileURLToPath(new URL('../../plugin', import.meta.url))
      : options.positional[0]
    if (!spec) {
      console.error('Usage: dsh-coexist install <package|path> [--self]')
      process.exitCode = 1
      return
    }
    const result = await installPlugin({ ...options, spec })
    console.log(options.json ? JSON.stringify(result, null, 2) : renderInstall(result))
    if (!result.ok && !result.dryRun) process.exitCode = 1
    return
  }

  if (options.command === 'uninstall') {
    const spec = options.positional[0]
    if (!spec) {
      console.error('Usage: dsh-coexist uninstall <package>')
      process.exitCode = 1
      return
    }
    const result = await uninstallPlugin({ ...options, spec })
    console.log(options.json ? JSON.stringify(result, null, 2) : renderUninstall(result))
    return
  }

  if (options.command === 'matrix') {
    const result = await buildMatrix(options)
    console.log(options.json ? JSON.stringify(result, null, 2) : renderMatrix(result))
    return
  }

  console.error(`Unknown command: ${options.command}`)
  console.log(HELP)
  process.exitCode = 1
}

main().catch((err) => {
  console.error(err.stack ?? err.message)
  process.exitCode = 1
})
