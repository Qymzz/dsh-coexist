# dsh-coexist（V0.1 MVP）

让 DSH 里两个不同的插件抢同一个资源时，**尽量都留下**，而不是默认卸载一个。

这是第一版可运行的最小实现，对应 [开发文档](../开发文档.md) 的 Phase 1 + Phase 2 的一小部分。

## 现在做了什么

### 插件端：自包含共存（桌面版主路径）

`packages/plugin` 是一个纯 ESM 的 DSH 插件，装进 profile 就能用，**不需要快捷方式、不需要环境变量**：

- 不声明 `inject: ['tools']`，因此在 tools 服务刚提供时立即安装原型 patch，早于所有 `inject` 插件的 `apply`。
- patch 的是宿主注册类 `ToolRuntime.prototype.register`（CLI 版为 `ToolsService`）。
- **只有宿主真的抛出 `tool "xxx" is already registered` 时**，才把第二个实现注册成 `xxx__coexist1`；不同作用域、不同 agent 的正常同名工具完全不碰。
- 其他错误（如 `run_code` 保留名、schema 非法）原样上抛，fail-open。
- 别名最多 64 字符，超长工具名会自动截断再拼后缀。
- 相同定义的重复注册只保留一个，不再制造多余别名。
- 别名调用次数、fallback 次数写入报告；可用 `dsh-coexist report` 查看。
- 启动 8 秒后写 `~/.dsh/coexist/report.json`：工具别名、service 冲突、失败/卡住插件、共享事件；失败会标注 `contract / service / dependency / runtime`。
- 卸载/HMR 时通过 `ctx.effect` 清空定时器、运行期 sink 和 hook 策略；未激活时探针退回原生行为。
- 可选 `mode: fallback`：主实现失败时降级到备份（默认关闭，避免双执行）。
- 可选 `serviceBridge: true`：两个 service 都是属性不重叠的普通对象时合并；否则只诊断。探针晚于冲突时，会自动释放失败 fiber 让 loader 重新加载并再次尝试。
- 可选 `serviceIsolate: true`：冲突的 service 给后加载插件独立作用域，双方各自可用；探针晚于冲突时同样会自动重载。
  普通用户默认不用开：只有报告里真的出现 service 冲突时再开启，开启后需要重启 DSH。

```yaml
# packages/plugin/cordis.patch.yml 的 config
config:
  mode: route             # alias（默认）| fallback | route
  serviceBridge: true     # 默认 false
  serviceIsolate: true    # 默认 false
```

运行期策略写在 `~/.dsh/coexist/config.json`（重启生效）：

```json
{
  "hooks": {
    "agent/pre-step": { "order": ["plugin-a"], "disable": ["plugin-b"] }
  },
  "routes": {
    "memory_search": { "by": "args", "match": { "scope": "code" } }
  }
}
```

实测日志（DSH 桌面版 2.0.21-next，连续 3 次重启一致）：

```text
[coexist] prototype patch active (internal/service: ToolRuntime)
[fixture-tool-a] registered memory_search
[fixture-tool-b] apply start
[coexist] alias memory_search -> memory_search__coexist1
[fixture-tool-b] registered memory_search
visible tools: memory_search, memory_search__coexist1, ...
memory_search           -> result from fixture A
memory_search__coexist1 -> result from fixture B
```

### 安装、卸载与版本矩阵

```powershell
# 装共存插件（自动识别 DSH 版本、校验兼容、写 profile、失败回滚）
node packages/cli/bin/dsh-coexist.js install --self --profile desktop

# 装任意插件（本地目录或 npm 包）
node packages/cli/bin/dsh-coexist.js install dsh-long-memory --profile desktop
node packages/cli/bin/dsh-coexist.js install ..\my-plugin --profile desktop

# 卸载（--purge 连同 ~/.dsh/coexist 的备份/报告/配置一起删除）
node packages/cli/bin/dsh-coexist.js uninstall dsh-long-memory --profile desktop
node packages/cli/bin/dsh-coexist.js uninstall dsh-coexist-plugin --profile desktop --purge

# 版本兼容矩阵
node packages/cli/bin/dsh-coexist.js matrix --profile desktop
```

已发布到 npm（`0.1.0`）：

- 插件：[dsh-coexist-plugin](https://www.npmjs.com/package/dsh-coexist-plugin)
- CLI：[dsh-coexist-cli](https://www.npmjs.com/package/dsh-coexist-cli)

从市场或 npm 安装时不需要先装 CLI：插件依赖会自动带上它。

安装器会：

- 从桌面 `app.asar` 读取 DSH 真实版本（也可 `--dsh-version` / `--app` 指定）；
- 检查 `engines.dsh` 和 peerDependencies 是否满足；
- 备份 `package.json` / `cordis.patch.yml` / lockfile，任何一步失败自动回滚；
- 把包加入 `dsh.profile.bundles`，下次启动生效；
- 自动恢复被 pnpm/npm 移到 `node_modules/.ignored` 的其它插件，避免"装一个插件把另一个弄没"。

### 卸载与清理

- **第三方插件**：移除 `dsh.profile.bundles`、`dependencies`、`node_modules/<name>`，以及本地安装时生成的
  `.dsh-coexist/plugins/<name>` 分阶段副本；npm 安装的插件本来就没有分阶段副本。
- **卸载共存插件本身**：在前面的基础上，再删除随插件分发的 `dsh-coexist-cli`、恢复旧版快捷方式启动器，
  并删除 `~/.dsh/coexist/desktop`；`.dsh-coexist` 变空后一起删除。
- **默认保留** `~/.dsh/coexist`（备份、报告、配置、审计）；确认不再需要时加 `--purge` 彻底删除。
- 从 DSH 宿主的“插件页”卸载也会触发同一套安装产物清理（插件包了一层 `pluginManager.removeBundle`）；
  `~/.dsh/coexist` 的备份/报告仍会保留，彻底清理请用设置页“卸载”或 `dsh-coexist uninstall --purge`。
- 插件日志写在 `~/.dsh/coexist/plugin.log`，不再放在旧启动器的 `desktop/` 目录。
- 旧版本遗留的分阶段副本（例如早期回归时装过的插件）不会因为卸载别的插件而消失，需要时可手动删除。

### 新增冲突类型（命令 / provider / UI 插槽 / 文件锁）

- **命令冲突**：后注册的 `/side` 自动变成 `/side__coexist1`，两个命令都保留。
- **provider 冲突**：后注册的 `workbuddy` 自动变成 `workbuddy__coexist1`，adapter 调用时自动换回原名。
- **UI 插槽 / 文件锁**：只能静态检测并报告；插槽在浏览器客户端注册，host 插件无法改名。

运行期策略写在 `~/.dsh/coexist/config.json`：

```json
{
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

- `services.<name>`：`bridge` / `isolate` / `block`，优先于全局开关。
- `serviceMerge.<name>.overlap`：`first` / `last`，仅在显式 bridge 时生效。
- `toolPolicies`：通过 `tools.guard()` 做同步门禁。
- `recover`：对失败插件各重试一次（默认关闭）。开启 `serviceBridge` / `serviceIsolate` / `services` 策略时，service 冲突失败的插件会自动释放并重载一次。

### 设置页（UI）

插件自带浏览器半边，在 DSH 的 **设置 → 插件共存** 提供：

- 状态卡片：Profile、插件数、运行期失败、别名、备份；
- 检查冲突、一键修复（先展示动作再确认）、回滚最近备份；
- 安装 / 卸载插件；
- 插件市场入口：切到宿主插件页的市场标签；宿主没有 `layout` 服务时回退到浏览器打开目录；
- 端口冲突卡片：释放端口；
- “保留原名”下拉：把选中的 bundle 移到第三方插件段最前，重启后它保留原名；
- service 隔离开关（写 `coexist/config.json`，重启生效）。

UI 的写操作统一转给 `dsh-coexist` CLI 执行，避免两套逻辑分叉。CLI 解析顺序：

1. 插件 config 的 `cliPath`（排障/自定义安装时用）；
2. 环境变量 `DSH_COEXIST_CLI`；
3. **插件依赖 `dsh-coexist-cli`**：安装插件时自动安装，通常不需要任何配置；
4. PATH 上的 `dsh-coexist`。

当前 profile 也会从宿主 loader 自动识别，不需要手动填 `profile`。

```yaml
# 可选覆盖；正常安装不需要
- id: coexist
  name: dsh-coexist-plugin
  config:
    profile: desktop
    cliPath: C:/path/to/dsh-coexist/packages/cli/bin/dsh-coexist.js
```

UI 只读取当前 profile 的备份；回滚不会误用其他 profile 的备份。

### 新增 CLI 命令

```powershell
node packages/cli/bin/dsh-coexist.js list --profile desktop
node packages/cli/bin/dsh-coexist.js audit --limit 20
node packages/cli/bin/dsh-coexist.js backups
node packages/cli/bin/dsh-coexist.js prefer <plugin> --profile desktop
node packages/cli/bin/dsh-coexist.js free-port 4100 --yes
node packages/cli/bin/dsh-coexist.js plan --profile desktop --dump-config
node packages/cli/bin/dsh-coexist.js apply --yes --plan <plan-id>
node packages/cli/bin/dsh-coexist.js rollback --id <backup-id>
node packages/cli/bin/dsh-coexist.js rollback --profile desktop --reinstall
```

`plan` 默认会在临时目录真实预演并输出文件级 diff；`--no-diff` 可跳过。`rollback --reinstall` 在恢复 package.json/lockfile 后按 lockfile 重装依赖。

### Launcher preload（可选，排障用）

`packages/cli` 的 `run` 命令会在 DSH 启动前：

1. 自动发现 DSH 安装位置（找不到时才用 `--dsh-bin`）；
2. 读取可选 watchlist；默认自动检测同名冲突；
3. 从 DSH 安装目录解析 `@deepseek-ai/dsh-tools`；
4. 用 `node --import preload.mjs <dsh-bin>` 启动 DSH。

默认是 auto 模式：只有原生 register 判定重名时才 alias；不同 agent scope 不碰。启动后只输出一句：

```text
[coexist] 已保留 N 个同名工具，无需操作。
```

> 桌面版已验证 Node/Electron 会剥离主进程的 `NODE_OPTIONS`，`--import preload.mjs` 不会传到 host 进程，因此桌面版**不要依赖这条路**；普通插件自包含已经是主路径。

```powershell
$env:DSH_HOME = "C:\path\to\dsh-home"
node packages/cli/bin/dsh-coexist.js run -- --profile web --port 3100 --no-open
```

不需要填 `--watch` 或 `--dsh-bin`；它们只作为调试覆盖。

如果要限制范围，才需要写 `$DSH_HOME/coexist/config.json`：

```json
{
  "watch": ["memory_search"]
}
```

### CLI / Web 真实调用（0.2.2-rc.5，历史验证）

- **Launcher 路径已跑通**：`node --import preload.mjs` 让 `[coexist] preload active` 出现在所有 fixture 的 `apply` 之前。
- **零参数已跑通**：不传 `--watch` / `--dsh-bin`，launcher 自动找到 DSH；auto 模式保留 1 个同名工具，核心工具没有误 alias。
- 两个 fixture 插件注册同名 `memory_search`；第二个变成 `memory_search__coexist1`，两个都在工具列表里，没有 `already registered` 错误。
- **Web UI 真实调用已验证**：agent 依次调用两个工具，分别返回 `result from fixture A` 和 `result from fixture B`。
- `ctx.tools.execute` 在插件上下文仍会失败；Web UI/agent 调用不受影响。

### 桌面版：直接装插件即可

桌面版（DSH NEXT 2.0.21-next）已验证：把 `dsh-coexist-plugin` 加进 profile 的 `dsh.profile.bundles`，正常双击 DSH 就能生效，用户不需要配环境变量、不需要新快捷方式。

下面的 `desktop install` 是早期实验路径，保留用于排障，**不是必需步骤**：

```powershell
node packages/cli/bin/dsh-coexist.js desktop install --yes
```

- 自动找到 `DSH NEXT.exe`；
- 备份并更新桌面/开始菜单的 DSH 快捷方式（同名同图标）；
- `launch.vbs` 内部设置 `NODE_OPTIONS`，用户不需要手动配；
- preload 日志：`$DSH_HOME/coexist/desktop/preload.log`；
- 完全退出 DSH 后，双击原来的 DSH 图标；
- 恢复：`dsh-coexist desktop restore`。

### CLI：启动前检测与修复

`packages/cli` 是一个零框架依赖的 Node CLI（只依赖 `yaml`）：

- `check`：扫描 profile 的 `package.json`、`cordis.patch.yml`、home 级 patch、每个 bundle 的 `dsh.bundle.patch` 和 peer 范围；检测 loader id、重复 bundle、patch 覆盖、peer 版本、声明/占用端口，并附带历史日志证据。
- `plan`：生成修复计划，不写文件。
- `apply --yes`：备份后修复：
  - loader entry id 冲突：把后出现的 `id` 改名，保留 `name` / config / 注释。
  - bundle 重复：去重 `dsh.profile.bundles`。
  - 端口冲突：在 profile/home 的可编辑行里换成下一个空闲端口。
  - patch 覆盖：追加一条完整 `replace` 行，恢复 disabled 和丢失的 config。
  - peer 冲突：只有显式 `--allow-peer-override` 才写入 pnpm/npm overrides，之后需要重新安装。
- `rollback`：恢复最近一次备份。
- `report`：读取插件写的运行期报告（service 冲突、失败/卡住插件、共享事件）。
- `run`：读 watchlist，注入 preload，然后启动 DSH。
- `desktop`：安装/恢复桌面版同身份快捷方式。

## 快速开始

```bash
cd dsh-coexist
npm install
npm test
```

### 看插件行为（不需要装 DSH）

```bash
npm run demo:plugin
```

输出会显示：A 注册 `memory_search`，B 注册同名工具后变成 `memory_search__coexist1`，两个都能调用。

### 看 CLI 检测

```bash
npm run cli -- check --home fixtures/home --profile web
npm run cli -- plan  --home fixtures/home --profile web
```

`check` / `plan` 只读。要试 `apply` / `rollback`，先复制一份 fixture：

```powershell
Copy-Item -Recurse fixtures/home .tmp-home
npm run cli -- apply --yes --home .tmp-home --profile web
npm run cli -- rollback --home .tmp-home
```

`apply` 会把第二个 `id: memory-entry` 改成 `id: memory-entry-b`，并去掉重复的 bundle；`rollback` 恢复原文件。

## 目录

```text
dsh-coexist/
├─ packages/
│  ├─ plugin/          # DSH 插件：自包含同名工具共存
│  │  ├─ index.js
│  │  ├─ src/patch.js  # ToolRuntime 原型 patch
│  │  ├─ src/diagnostics.js  # 运行期诊断与 report.json
│  │  ├─ src/aliasing.js
│  │  └─ cordis.patch.yml
│  └─ cli/             # 检测/修复 + launcher
│     ├─ bin/dsh-coexist.js
│     ├─ preload.mjs
│     └─ src/          # 含 preload/patch.js、launcher.js
├─ fixtures/home/      # 演示用 DSH_HOME
└─ README.md
```

## 还没做

- 运行期 dispatcher 的多实现 merge（相同定义去重、fallback、按参数/agent 路由已完成）。
- 事件 hook 的自动冲突判定（目前需要在 `config.json` 手工配置 order/disable）。
- service key 的进程隔离（上下文隔离与有限代理已完成）。
- 设置页 / 客户端 UI。

> 桌面版注入 spike（历史）：wrapper 设置 `NODE_OPTIONS=--import preload.mjs` 后，在 CLI 场景可用；但桌面版主进程会剥离 `NODE_OPTIONS`，host 进程收不到，所以该路径已降级为实验/排障。桌面版最终验证走的是插件自包含 patch。

## 本地挂插件（不上架）

```bash
npx @deepseek-ai/dsh web --patch ./packages/plugin/cordis.yml
```

草稿 patch 里的插件路径要写绝对路径；`packages/plugin/cordis.patch.yml` 是按包名写的版本，用于发布后安装。

注意：现在单独挂插件就会安装原型 patch，桌面版无需 CLI。

## 打包上架

`packages/plugin/package.json` 已经包含：

- `type: module`
- `main` / `exports`（含 `./client`）
- `files` 包含 `index.js`、`src`、`lib`、`assets`、`cordis.patch.yml`
- `dsh.bundle.patch` 与 `dsh.client`（设置页）
- `engines.dsh: >=0.2.0 <0.3.0`
- `dependencies` 里的 `dsh-coexist-cli`（设置页通过它执行写操作）
- `icon: assets/icon.svg` 与市场用 `README.md`

发布到 npm 后，用户可以：

```bash
# 市场内安装，或
dsh-coexist install dsh-coexist-plugin --profile desktop
```

CLI 是独立 npm 包，不是 DSH 插件；它作为插件依赖随插件安装，不需要单独上架。
市场索引条目见 [market/index.json](market/index.json)，上架前需要把 `OWNER` 换成真实 GitHub 账号，
并在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR。

## 安全边界

- CLI 默认只读；`apply` 必须 `--yes`，并先备份。
- 不修改第三方插件源码。
- 插件端 fail-open：包装失败时退回原生行为。
- 不做假路由、不做静默替换。
- 设置页接口只接受 `POST` + `application/json`，只允许本机回环连接，`Origin` 为 http(s) 时必须同源；
  跨站表单、`text/plain` 请求和局域网来源都会被拒绝。
- 卸载、回滚、结束端口进程在 UI 里都有二次确认；安装/卸载/回滚前都会先备份。
