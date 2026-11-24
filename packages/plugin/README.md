# dsh-coexist-plugin

**让 DSH 插件一起工作：两个插件抢同一个工具或命令时不用卸载，后装的那个自动加后缀，两个都能用；设置页统一管理依赖、冲突、回滚、路由和调用策略。**  
*Plugin coexistence for DeepSeek Harness: when two plugins claim the same tool, command, provider or service, keep both instead of silently dropping one.*

---

## 它解决什么

DSH 里装了两个插件、它们注册了同一个工具名时，后加载的那个通常会失败或覆盖前一个。`dsh-coexist-plugin` 在宿主注册阶段接管冲突：

- **同名 tool**：第二个实现自动注册为 `name__coexist1`（N 个插件依次 `__coexist2`…），两个都能调用。
- **同名命令 / provider**：运行期自动加后缀别名，调用记录写入报告。
- **service key 冲突**：诊断双方来源；可选有限代理或上下文隔离，让双方各自可用。
- **设置页「插件治理」**：治理概览、依赖与加载顺序、别名路由、工具策略、调用统计、检查冲突、一键修复、回滚、安装/卸载、端口释放，全部可视化操作。

## 安装

npm：[dsh-coexist-plugin](https://www.npmjs.com/package/dsh-coexist-plugin) ·
CLI：[dsh-coexist-cli](https://www.npmjs.com/package/dsh-coexist-cli)

已上架 awesome-dsh-plugin 市场，可直接在市场内安装。也可以：

```powershell
# 通过 CLI 安装（会自动做版本检查、写 profile、失败回滚）
dsh-coexist install dsh-coexist-plugin --profile desktop

# 没有全局 CLI 时
npx dsh-coexist-cli install dsh-coexist-plugin --profile desktop
```

插件自带 `dsh-coexist-cli` 依赖，设置页不依赖全局命令；卸载插件不会残留全局工具。

安装完成后重启 DSH，在 **设置 → 插件治理** 查看状态。

## 设置页

「插件治理」提供：

| 操作 | 说明 |
|---|---|
| 治理概览 | 插件、冲突、别名、路由规则、策略规则、工具调用、备份 |
| 依赖与加载顺序 | SVG 依赖图、顺序、版本、peer 缺口、循环依赖；缺失 peer 可一键安装 |
| 别名路由 | 表单编辑 `routes`，按 agent / 参数 / index 选择同名工具的实现；保存前可校验 |
| 工具策略 | 表单编辑 `toolPolicies`，按工具名 / agent 允许或拒绝调用；保存前可校验 |
| 调用统计 | 调用次数、错误、拦截、平均耗时、p95、按 agent 拆分、慢调用 Top |
| 刷新状态 | 当前 profile、插件数、运行期失败、别名数、备份数 |
| 检查冲突 | 静态扫描 + 端口探测 + 日志，列出可修复项 |
| 一键修复 | 生成计划并应用（loader id、重复 bundle、端口、patch 覆盖） |
| 回滚最近备份 | 恢复 `package.json` / `cordis.patch.yml` / lockfile，可重新安装依赖 |
| 安装 / 卸载 | 安装前做兼容检查，失败自动回滚 |
| 插件市场 | 一键跳到宿主插件页的市场标签；没有市场面板时回退到浏览器目录 |
| service 隔离 | 两个插件提供同名服务时，让后加载的插件用自己的副本；默认关闭，出现 service 冲突再开 |
| 保留原名 | 把某个插件放到第三方插件段最前，冲突时它保留原名 |

所有写操作都会先备份，并写入本地 `audit.jsonl`。

## 卸载

- 在设置页「已启用插件」里点 **卸载**，或执行
  `dsh-coexist uninstall dsh-coexist-plugin --profile desktop --purge`。
- 会移除 bundle、依赖、`node_modules` 安装目录、本地安装的分阶段副本，以及随插件分发的 CLI。
- 加 `--purge` 会连同 `~/.dsh/coexist`（备份、报告、配置）一起删除；不加则保留，方便以后回滚或排查。
- 从 DSH 宿主的“插件页”卸载会清理安装产物（分阶段副本、CLI、旧启动器）；
  备份/报告仍保留，彻底清理请用 `--purge`。
- 插件日志写在 `~/.dsh/coexist/plugin.log`。

## 兼容性

- DSH 桌面版 **2.0.21-next**（内部 `@deepseek-ai/dsh` **0.2.1-rc.4**）实测通过。
- 声明 `engines.dsh: ">=0.2.0 <0.3.0"`；`@deepseek-ai/dsh >=0.2.0` 为可选 peer。
- 目前只在 **Windows** 上做过真实回归；其他平台未验证。
- 与 DSH 官方 bundle、`dshmarket`、`@deepseek-ai/dsh-web-app` 同场加载无冲突。

## 安全与隐私

- 设置页接口先经过 DSH 原生 Connection 检查（Host/Origin 与浏览器会话），再叠加 `localhost` 回环、`POST` + `application/json`、同源校验。
- 接口只接受 `POST` + `application/json`、本机回环连接；http(s) `Origin` 必须同源。
  跨站表单、`text/plain` 请求和局域网来源都会被拒绝。
- 插件本身不联网、不上传任何数据；所有状态写入本地 `~/.dsh/coexist`。
- 安装/卸载会校验包名并限制在 profile 目录内，拒绝 `../`、绝对路径和非法 profile 名。
- Windows 下不通过 `cmd.exe` 执行 `npm.cmd` / `dsh.cmd`；找不到 `npm-cli.js` 时直接报错。
- 释放端口前用 `tasklist` 校验进程身份；非 `node.exe` / DSH 进程默认跳过，需要 `--force`。
- 安装/卸载/回滚都会先备份；卸载、回滚、结束端口进程在 UI 中有二次确认。
- `serviceIsolate` 默认关闭，需显式开启并重启。

## 已知限制

- UI 插槽（浏览器客户端注册）与文件锁冲突只能报告，host 插件无法安全改名。
- service 只做到诊断、有限代理与上下文隔离，不做跨进程隔离。
- 不处理语义互斥（两个工具逻辑上不能同时启用）。
- 不提供字节级 `node_modules` 回滚。

## License

MIT
