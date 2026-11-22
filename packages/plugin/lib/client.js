window.__ModuleLoader__.load({
  id: 'dsh-coexist-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const INJECT = ['slots', 'layout']
    let hostContext = null

    const CSS = `
.dsh-coexist-section{max-width:920px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}
.dsh-coexist-head{display:flex;align-items:baseline;gap:10px}
.dsh-coexist-title{margin:0;font-size:18px;font-weight:600}
.dsh-coexist-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsh-coexist-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}
.dsh-coexist-card h3{margin:0;font-size:14px;font-weight:600}
.dsh-coexist-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-coexist-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 11px;font-size:12px}
.dsh-coexist-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-coexist-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-overlay)}
.dsh-coexist-btn.danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-coexist-btn:disabled{opacity:.45;cursor:default}
.dsh-coexist-input{flex:1;min-width:220px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;font-size:13px;outline:none}
.dsh-coexist-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-coexist-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.dsh-coexist-item{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dsh-coexist-item-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-coexist-tag{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;white-space:nowrap}
.dsh-coexist-tag.error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-coexist-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsh-coexist-msg{font-size:12px;border-radius:8px;padding:7px 10px}
.dsh-coexist-msg.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.dsh-coexist-msg.error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dsh-coexist-msg.info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dsh-coexist-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.dsh-coexist-kv{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px}
.dsh-coexist-kv .k{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-coexist-kv .v{font-size:14px;font-weight:600;margin-top:2px}
.dsh-coexist-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px;font-size:12px}
.dsh-coexist-code{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
`

    async function api(method, body) {
      const res = await fetch('/coexist-api/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      let payload
      try {
        payload = await res.json()
      } catch {
        throw new Error('HTTP ' + res.status)
      }
      if (!res.ok || payload?.ok === false) {
        throw new Error(payload?.error || ('HTTP ' + res.status))
      }
      return payload
    }

    function countOf(list) {
      return Array.isArray(list) ? list.length : 0
    }

    function AliasList({ title, rows }) {
      if (!rows?.length) return null
      return h(
        'div',
        null,
        h('div', { className: 'dsh-coexist-muted' }, title),
        h(
          'ul',
          { className: 'dsh-coexist-list' },
          rows.map((row, index) =>
            h(
              'li',
              { className: 'dsh-coexist-item', key: index },
              h('span', { className: 'dsh-coexist-item-main' }, row.name),
              h('span', { className: 'dsh-coexist-code' }, '→ ' + row.alias),
            ),
          ),
        ),
      )
    }

    function Section(props) {
      const [status, setStatus] = React.useState(null)
      const [graph, setGraph] = React.useState(null)
      const [plan, setPlan] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [spec, setSpec] = React.useState('')

      // 市场入口：切到宿主「插件」页并关闭设置覆盖层；宿主没有 layout 服务时回退到目录站。
      const openMarket = () => {
        const layout = hostContext?.layout ?? hostContext?.get?.('layout')
        if (layout && typeof layout.selectPanel === 'function') {
          try {
            layout.selectPanel('plugins')
            if (typeof props?.close === 'function') props.close()
            return
          } catch {
            // 继续走浏览器回退。
          }
        }
        window.open('https://awesome-dsh-plugin.com', '_blank', 'noopener')
      }

      const notify = (kind, text) => setMessage({ kind, text })
      const fail = (error) => notify('error', String(error?.message || error))

      const refresh = async () => {
        setBusy('refresh')
        try {
          const next = await api('status')
          setStatus(next)
          setMessage(null)
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      React.useEffect(() => {
        refresh()
      }, [])

      const runCheck = async () => {
        setBusy('check')
        try {
          const res = await api('check')
          setGraph(res.value)
          const conflicts = countOf(res.value?.conflicts)
          notify('ok', conflicts ? `发现 ${conflicts} 个冲突` : '没有发现冲突')
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const runPlan = async () => {
        setBusy('plan')
        try {
          const res = await api('plan')
          setPlan(res.value)
          const actions = countOf(res.value?.actions)
          notify(actions ? 'info' : 'ok', actions ? `生成 ${actions} 个修复动作，确认后应用` : '没有需要修复的项')
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const runApply = async () => {
        if (!plan?.id) return
        setBusy('apply')
        try {
          await api('apply', { planId: plan.id })
          setPlan(null)
          await refresh()
          notify('ok', '修复已应用。重启 DSH 后完全生效。')
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const runRollback = async (id) => {
        if (!window.confirm('回滚会覆盖当前 profile 配置，继续？')) return
        setBusy('rollback')
        try {
          await api('rollback', { id, reinstall: true })
          await refresh()
          notify('ok', '已回滚，并按 lockfile 重装依赖。重启 DSH 后生效。')
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const runInstall = async () => {
        const value = spec.trim()
        if (!value) return
        setBusy('install')
        try {
          const res = await api('install', { spec: value })
          setSpec('')
          await refresh()
          notify('ok', `已安装 ${res.value?.plugin?.name || value}@${res.value?.plugin?.version || ''}。重启 DSH 后加载。`)
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const runUninstall = async (name) => {
        const self = name === 'dsh-coexist-plugin'
        const question = self
          ? '卸载插件共存？设置页会消失，已安装的其他插件不受影响；备份和报告会保留（彻底清理请用 CLI 的 --purge）。继续？'
          : `卸载 ${name}？会移除它的 bundle、依赖、安装目录和分阶段副本。继续？`
        if (!window.confirm(question)) return
        setBusy('uninstall')
        try {
          await api('uninstall', { name })
          await refresh()
          notify('ok', self ? '已卸载插件共存。重启 DSH 后设置页消失。' : `已卸载 ${name}。重启 DSH 后生效。`)
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const runFreePort = async (port) => {
        if (!window.confirm(`结束占用端口 ${port} 的进程？`)) return
        setBusy('free-port')
        try {
          const res = await api('free-port', { port })
          notify('ok', res.value?.killed?.length ? `已结束进程：${res.value.killed.join(', ')}` : `端口 ${port} 已空闲`)
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const runPrefer = async (plugin) => {
        if (!plugin) return
        setBusy('prefer')
        try {
          await api('prefer', { plugin })
          await refresh()
          notify('ok', `已把 ${plugin} 排到最前，重启后它保留原名。`)
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const toggleIsolate = async (checked) => {
        setBusy('config')
        try {
          const res = await api('config', { patch: { serviceIsolate: checked } })
          setStatus((prev) => (prev ? { ...prev, config: res.config } : prev))
          notify('ok', `service 隔离已${checked ? '开启' : '关闭'}，重启 DSH 后生效。`)
        } catch (error) {
          fail(error)
        } finally {
          setBusy('')
        }
      }

      const report = status?.report
      const conflicts = graph?.conflicts ?? report?.serviceConflicts ?? []
      const aliasRows = [
        ...(report?.tools?.aliases ?? []).map((row) => ({ ...row, kind: 'tool' })),
        ...(report?.commands?.aliases ?? []).map((row) => ({ ...row, kind: 'command' })),
        ...(report?.providers?.aliases ?? []).map((row) => ({ ...row, kind: 'provider' })),
      ]
      const graphConflicts = graph?.conflicts ?? []
      const bundleNames = new Set(status?.bundles ?? [])
      const busyOn = (name) => busy === name

      return h(
        'div',
        { className: 'dsh-coexist-section' },
        h(
          'div',
          { className: 'dsh-coexist-head' },
          h('h2', { className: 'dsh-coexist-title' }, '插件共存'),
          h('span', { className: 'dsh-coexist-sub' }, '冲突检测、一键修复、安装与回滚'),
        ),

        message
          ? h('div', { className: 'dsh-coexist-msg ' + message.kind }, message.text)
          : null,

        h(
          'div',
          { className: 'dsh-coexist-card' },
          h('div', { className: 'dsh-coexist-row' },
            h('button', { className: 'dsh-coexist-btn primary', onClick: refresh, disabled: !!busy }, busyOn('refresh') ? '刷新中…' : '刷新状态'),
            h('button', { className: 'dsh-coexist-btn', onClick: runCheck, disabled: !!busy }, busyOn('check') ? '检查中…' : '检查冲突'),
            h('button', { className: 'dsh-coexist-btn', onClick: runPlan, disabled: !!busy }, busyOn('plan') ? '生成中…' : '一键修复'),
            h('button', { className: 'dsh-coexist-btn danger', onClick: () => runRollback(), disabled: !!busy || !status?.backups?.length }, busyOn('rollback') ? '回滚中…' : '回滚最近备份'),
          ),
          status
            ? h(
                'div',
                { className: 'dsh-coexist-grid' },
                h('div', { className: 'dsh-coexist-kv' }, h('div', { className: 'k' }, 'Profile'), h('div', { className: 'v' }, status.profile)),
                h('div', { className: 'dsh-coexist-kv' }, h('div', { className: 'k' }, '插件'), h('div', { className: 'v' }, String(countOf(status.bundles)))),
                h('div', { className: 'dsh-coexist-kv' }, h('div', { className: 'k' }, '运行期失败'), h('div', { className: 'v' }, String(countOf(report?.failures)))),
                h('div', { className: 'dsh-coexist-kv' }, h('div', { className: 'k' }, '别名'), h('div', { className: 'v' }, String(aliasRows.length))),
                h('div', { className: 'dsh-coexist-kv' }, h('div', { className: 'k' }, '备份'), h('div', { className: 'v' }, String(countOf(status.backups)))),
              )
            : h('div', { className: 'dsh-coexist-muted' }, '正在读取状态…'),
          status?.cli && status.cli.ok === false
            ? h('div', { className: 'dsh-coexist-msg error' }, 'CLI 不可用：' + status.cli.error)
            : null,
        ),

        plan?.actions?.length
          ? h(
              'div',
              { className: 'dsh-coexist-card' },
              h('h3', null, `修复计划（${plan.actions.length}）`),
              h(
                'ul',
                { className: 'dsh-coexist-list' },
                plan.actions.map((action, index) =>
                  h(
                    'li',
                    { className: 'dsh-coexist-item', key: index },
                    h('span', { className: 'dsh-coexist-item-main' }, action.kind + (action.owner ? ' · ' + action.owner : '')),
                    h('span', { className: 'dsh-coexist-code' }, action.oldPort ? `${action.oldPort} → ${action.newPort}` : action.file || ''),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dsh-coexist-row' },
                h('button', { className: 'dsh-coexist-btn primary', onClick: runApply, disabled: !!busy }, busyOn('apply') ? '应用中…' : '应用修复'),
                h('button', { className: 'dsh-coexist-btn', onClick: () => setPlan(null), disabled: !!busy }, '取消'),
              ),
            )
          : null,

        graphConflicts.length
          ? h(
              'div',
              { className: 'dsh-coexist-card' },
              h('h3', null, '冲突'),
              h(
                'ul',
                { className: 'dsh-coexist-list' },
                graphConflicts.map((conflict, index) => {
                  const type = conflict.resource?.type ?? 'unknown'
                  const key = conflict.resource?.key ?? ''
                  const owners = conflict.owners ?? []
                  const bundleOwners = owners.filter((owner) => bundleNames.has(owner))
                  return h(
                    'li',
                    { className: 'dsh-coexist-item', key: index },
                    h('span', { className: 'dsh-coexist-item-main' }, `${type} · ${key} — ${owners.join(' / ')}`),
                    type === 'port'
                      ? h('button', { className: 'dsh-coexist-btn', onClick: () => runFreePort(Number(key)), disabled: !!busy || !Number.isInteger(Number(key)) }, '释放端口')
                      : null,
                    bundleOwners.length > 1
                      ? h(
                          'select',
                          {
                            className: 'dsh-coexist-select',
                            defaultValue: '',
                            onChange: (event) => runPrefer(event.target.value),
                            disabled: !!busy,
                          },
                          h('option', { value: '' }, '保留原名…'),
                          bundleOwners.map((owner) => h('option', { key: owner, value: owner }, owner)),
                        )
                      : null,
                  )
                }),
              ),
            )
          : null,

        aliasRows.length
          ? h(
              'div',
              { className: 'dsh-coexist-card' },
              h('h3', null, '当前别名'),
              h(AliasList, { title: '工具', rows: aliasRows.filter((row) => row.kind === 'tool') }),
              h(AliasList, { title: '命令', rows: aliasRows.filter((row) => row.kind === 'command') }),
              h(AliasList, { title: 'Provider', rows: aliasRows.filter((row) => row.kind === 'provider') }),
            )
          : null,

        report?.failures?.length
          ? h(
              'div',
              { className: 'dsh-coexist-card' },
              h('h3', null, '运行期失败'),
              h(
                'ul',
                { className: 'dsh-coexist-list' },
                report.failures.map((failure, index) =>
                  h(
                    'li',
                    { className: 'dsh-coexist-item', key: index },
                    h('span', { className: 'dsh-coexist-tag error' }, failure.kind || 'runtime'),
                    h('span', { className: 'dsh-coexist-item-main' }, `${failure.plugin}: ${failure.error}`),
                  ),
                ),
              ),
            )
          : null,

        h(
          'div',
          { className: 'dsh-coexist-card' },
          h('h3', null, '安装插件'),
          h(
            'div',
            { className: 'dsh-coexist-row' },
            h('input', {
              className: 'dsh-coexist-input',
              value: spec,
              placeholder: 'npm 包名或本地路径，例如 @scope/dsh-plugin',
              onChange: (event) => setSpec(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') runInstall()
              },
            }),
            h('button', { className: 'dsh-coexist-btn primary', onClick: runInstall, disabled: !!busy || !spec.trim() }, busyOn('install') ? '安装中…' : '安装'),
          ),
          h('div', { className: 'dsh-coexist-muted' }, '安装前会做版本检查；失败会自动回滚 package.json 与 lockfile。'),
        ),

        h(
          'div',
          { className: 'dsh-coexist-card' },
          h('h3', null, '插件市场'),
          h('div', { className: 'dsh-coexist-muted' }, '在插件页的市场标签中搜索并一键安装；装完回到这里检查冲突。'),
          h(
            'div',
            { className: 'dsh-coexist-row' },
            h('button', { className: 'dsh-coexist-btn', onClick: openMarket }, '打开插件市场'),
            h(
              'button',
              { className: 'dsh-coexist-btn', onClick: () => window.open('https://awesome-dsh-plugin.com', '_blank', 'noopener') },
              '在浏览器打开目录',
            ),
          ),
        ),

        h(
          'div',
          { className: 'dsh-coexist-card' },
          h('h3', null, '已启用插件'),
          status?.bundles?.length
            ? h(
                'ul',
                { className: 'dsh-coexist-list' },
                status.bundles.map((name) =>
                  h(
                    'li',
                    { className: 'dsh-coexist-item', key: name },
                    h('span', { className: 'dsh-coexist-item-main' }, name),
                    h('button', { className: 'dsh-coexist-btn danger', onClick: () => runUninstall(name), disabled: !!busy }, '卸载'),
                  ),
                ),
              )
            : h('div', { className: 'dsh-coexist-muted' }, '没有已启用插件。'),
          h(
            'div',
            { className: 'dsh-coexist-muted' },
            '从宿主插件页卸载会保留共存备份/报告；需要彻底清理请用这里的「卸载」或 CLI 的 --purge。',
          ),
        ),

        h(
          'div',
          { className: 'dsh-coexist-card' },
          h('h3', null, '运行策略'),
          h(
            'label',
            { className: 'dsh-coexist-row' },
            h('input', {
              type: 'checkbox',
              checked: status?.config?.serviceIsolate === true,
              disabled: !!busy || !status,
              onChange: (event) => toggleIsolate(event.target.checked),
            }),
            h('span', null, 'service 冲突时自动隔离（重启生效）'),
          ),
          h(
            'div',
            { className: 'dsh-coexist-muted' },
            '两个插件提供同名服务时，让后加载的插件使用自己的副本，避免互相覆盖。默认关闭；只有检查结果里出现 service 冲突时才建议开启，开启后需重启 DSH。',
          ),
          status?.config?.services
            ? h('div', { className: 'dsh-coexist-muted' }, '已配置的服务策略：' + Object.keys(status.config.services).join(', '))
            : null,
        ),

        status?.backups?.length
          ? h(
              'div',
              { className: 'dsh-coexist-card' },
              h('h3', null, '备份'),
              h(
                'ul',
                { className: 'dsh-coexist-list' },
                status.backups.slice(0, 5).map((id) =>
                  h(
                    'li',
                    { className: 'dsh-coexist-item', key: id },
                    h('span', { className: 'dsh-coexist-item-main' }, id),
                    h('button', { className: 'dsh-coexist-btn', onClick: () => runRollback(id), disabled: !!busy }, '回滚'),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    function apply(ctx) {
      hostContext = ctx
      const slots = ctx.get('slots')
      if (!slots) return
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin', 'dsh-coexist-plugin')
      tag.textContent = CSS
      document.head.appendChild(tag)

      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'coexist',
            order: 16,
            label: () => '插件共存',
          },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = INJECT
    return module.exports
  },
})
