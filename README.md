# dsh-coexist

DSH 插件共存工具（0.1.1）。

当两个插件抢同一个工具、命令、provider 或 service 时，尽量让它们都留下，而不是默认卸载一个。

- npm 插件：[dsh-coexist-plugin](https://www.npmjs.com/package/dsh-coexist-plugin)
- npm CLI：[dsh-coexist-cli](https://www.npmjs.com/package/dsh-coexist-cli)
- GitHub：https://github.com/Qymzz/dsh-coexist
- 市场：已合并（PR [#17878](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17878)）
- 兼容：DSH 0.2.x，已在 DSH NEXT 2.0.21-next / `@deepseek-ai/dsh` 0.2.1-rc.4 验证
- 平台：Windows

## 解决什么问题

| 冲突类型 | 处理方式 |
|---|---|
| 同名 tool | 第二个注册变成 `xxx__coexist1`，两个都可调用 |
| 同名命令 | 第二个变成 `/xxx__coexist1`，两个都保留 |
| 同名 provider | 第二个变成 `xxx__coexist1`，adapter 自动换回原名 |
| 相同定义重复注册 | 去重，不制造多余别名 |
| service key | 检测并报告；可选 bridge / isolate |
| loader id、重复 bundle、端口、patch 覆盖、peer | CLI 检查并修复 |
| UI 插槽、文件锁 | 只做静态检测和报告，运行期无法安全改名 |

只有宿主真的抛出“已注册”错误时才做别名；不同 agent、不同作用域的正常同名工具不会被改动。

## 安装

### 方式一：DSH 插件页 / 市场

在 DSH 的 **插件 → 添加插件** 里填：

```text
dsh-coexist-plugin
```

市场 PR 合并后，也可以直接从市场安装。

### 方式二：CLI

```powershell
npx dsh-coexist-cli install dsh-coexist-plugin --profile desktop
```

安装器会：

- 从桌面 `app.asar` 读取 DSH 真实版本，也可用 `--dsh-version` / `--app` 指定
- 检查 `engines.dsh` 和 `peerDependencies`
- 备份 `package.json`、`cordis.patch.yml`、lockfile，失败自动回滚
- 把包加入 `dsh.profile.bundles`，下次启动生效
- 自动恢复被 pnpm/npm 移到 `node_modules/.ignored` 的其它插件

插件依赖会自动带上 CLI，不需要先单独安装。

安装后重启 DSH，在 **设置 → 插件共存** 查看状态。

### 验证

```powershell
npx dsh-coexist-cli check --profile desktop
npx dsh-coexist-cli matrix --profile desktop
```

`check` 只读；`matrix` 显示当前 profile 的插件和版本兼容情况。

## 设置页

DSH 的 **设置 → 插件共存** 提供：

- 状态卡片：Profile、插件数、运行期失败、别名、备份
- 检查冲突、一键修复（先展示动作再确认）、回滚最近备份
- 安装 / 卸载插件
- 插件市场入口：切到宿主插件页的市场标签；宿主没有 `layout` 服务时回退到浏览器打开目录
- 端口冲突卡片：释放端口
- “保留原名”下拉：把选中的 bundle 移到第三方插件段最前，重启后它保留原名
- service 隔离开关（写 `coexist/config.json`，重启生效）

设置页的写操作统一转给 CLI 执行，避免两套逻辑分叉。CLI 解析顺序：

1. 插件 config 的 `cliPath`（排障/自定义安装时用）
2. 环境变量 `DSH_COEXIST_CLI`
3. 插件依赖 `dsh-coexist-cli`（正常安装自动带上）
4. PATH 上的 `dsh-coexist`

当前 profile 从宿主 loader 自动识别，不需要手动填 `profile`。UI 只读取当前 profile 的备份。

## 常用 CLI

```powershell
npx dsh-coexist-cli check --profile desktop
npx dsh-coexist-cli plan --profile desktop
npx dsh-coexist-cli apply --yes --profile desktop
npx dsh-coexist-cli rollback --profile desktop
npx dsh-coexist-cli report
npx dsh-coexist-cli list --profile desktop
npx dsh-coexist-cli audit --limit 20
npx dsh-coexist-cli backups
npx dsh-coexist-cli prefer <plugin> --profile desktop
npx dsh-coexist-cli free-port 4100 --yes
npx dsh-coexist-cli install <plugin|包名|本地目录> --profile desktop
npx dsh-coexist-cli uninstall <plugin> --profile desktop
npx dsh-coexist-cli matrix --profile desktop
```

`apply` 必须加 `--yes`，并会先备份。`rollback` 默认恢复最近一次备份；`rollback --reinstall` 会在恢复 `package.json` / lockfile 后按 lockfile 重装依赖。

卸载默认保留 `~/.dsh/coexist`（备份、报告、配置、审计）。确认不再需要时加 `--purge`。

## 配置

运行期策略写在 `~/.dsh/coexist/config.json`（重启生效）：

```json
{
  "hooks": {
    "agent/pre-step": { "order": ["plugin-a"], "disable": ["plugin-b"] }
  },
  "routes": {
    "memory_search": { "by": "args", "match": { "scope": "code" } }
  },
  "services": {
    "demo-service": "isolate"
  },
  "serviceMerge": {
    "demo-service": { "overlap": "last" }
  },
  "toolPolicies": {
    "memory_search": {
      "allowAgents": ["agent-x"],
      "denyAgents": ["agent-y"],
      "deny": false
    }
  },
  "recover": true
}
```

- `services.<name>`：`bridge` / `isolate` / `block`，优先于全局开关
- `serviceMerge.<name>.overlap`：`first` / `last`，仅在显式 bridge 时生效
- `toolPolicies`：通过 `tools.guard()` 做同步门禁
- `recover`：对失败插件各重试一次（默认关闭）

插件自身的 config 在 `packages/plugin/cordis.patch.yml`：

```yaml
config:
  mode: alias             # alias（默认）| fallback | route
  serviceBridge: false    # 默认关闭
  serviceIsolate: false   # 默认关闭
  watch: []               # 留空表示自动接管所有工具名
```

普通用户默认不需要开 `serviceBridge` / `serviceIsolate`。只有报告里真的出现 service 冲突，或某个插件的 service 功能异常时再开启，开启后需要重启 DSH。

## 兼容性

- DSH：`>=0.2.0 <0.3.0`
- 已验证：DSH NEXT 2.0.21-next、`@deepseek-ai/dsh` 0.2.1-rc.4
- 平台：Windows
- CLI 运行时：Node `^22.19.0 || >=24.0.0`
- 桌面版不需要快捷方式、不需要环境变量；插件装进 profile 即可
- 同名工具别名、运行期诊断不需要 CLI；设置页的写操作需要 CLI，npm 安装会自动带上

## 安全边界

- CLI 默认只读；`apply` 必须 `--yes`，并先备份
- 不修改第三方插件源码
- 插件端 fail-open：包装失败时退回原生行为
- 不做假路由、不做静默替换
- 设置页接口先经过 DSH 原生 Connection 检查（Host/Origin 与浏览器会话），再叠加本机回环、`POST` + `application/json`、同源校验
- 跨站表单、`text/plain` 请求和局域网来源都会被拒绝
- 卸载、回滚、结束端口进程在 UI 里都有二次确认

## 已知限制

- 运行期 dispatcher 的多实现 merge 未实现；相同定义去重、fallback、按参数/agent 路由已完成
- 事件 hook 的自动冲突判定未实现；目前需要在 `config.json` 手工配置 order/disable
- service key 的进程隔离未实现；上下文隔离和有限代理已完成
- UI 插槽、文件锁只能静态检测；host 插件无法在运行期安全改名
- 真实 HMR 晚于其它插件加载时，已经注册的名字无法追溯改名
- 非 Windows 平台未验证
- 不做语义自动合并

## 本地开发

```powershell
cd dsh-coexist
npm install
npm test
```

看插件行为（不需要安装 DSH）：

```powershell
npm run demo:plugin
```

看 CLI 检测：

```powershell
npm run cli -- check --home fixtures/home --profile web
npm run cli -- plan  --home fixtures/home --profile web
```

`check` / `plan` 只读。要试 `apply` / `rollback`，先复制一份 fixture：

```powershell
Copy-Item -Recurse fixtures/home .tmp-home
npm run cli -- apply --yes --home .tmp-home --profile web
npm run cli -- rollback --home .tmp-home
```

### 本地挂插件

`packages/plugin/cordis.patch.yml` 是**发布版** bundle patch，里面用包名：

```yaml
name: dsh-coexist-plugin
```

它适用于安装后的 profile。本地 `npx @deepseek-ai/dsh web --patch` 时，如果包还没有安装到可解析的位置，需要单独写一个开发用 patch，把插件目录写成绝对路径，例如：

```yaml
- insert:
    - id: coexist
      name: D:/TsymQ/MyProject/ds-adapt/dsh-coexist/packages/plugin
      config:
        mode: alias
```

这个开发用 patch 不要放进发布包；发布版继续用 `cordis.patch.yml`。

## 发布状态

- npm：`dsh-coexist-plugin@0.1.1`、`dsh-coexist-cli@0.1.1`
- GitHub：https://github.com/Qymzz/dsh-coexist
- 市场：已合并（PR [#17878](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17878)）
- 自托管索引：`market/index.json`
- 许可证：MIT，见 [LICENSE](LICENSE)

## 目录

```text
dsh-coexist/
├─ packages/
│  ├─ plugin/          # DSH 插件：自包含同名工具共存 + 设置页
│  │  ├─ index.js
│  │  ├─ lib/client.js
│  │  ├─ src/patch.js
│  │  ├─ src/diagnostics.js
│  │  ├─ src/aliasing.js
│  │  └─ cordis.patch.yml
│  └─ cli/             # 检测/修复 + 安装/卸载
│     ├─ bin/dsh-coexist.js
│     ├─ preload.mjs
│     └─ src/
├─ fixtures/home/      # 演示用 DSH_HOME
└─ README.md
```
