# Windows 安装与验证

需要 Node.js 24+、Git、已登录的 Codex CLI 和安装了官方 base / ACP bundle 的 DeepSeek Harness。以下命令在仓库根目录的 PowerShell 中执行。

## 运行时与配置

先将 Node 24 的目录加入当前终端 PATH，再执行 `node --version` 确认版本。DSH Desktop 自带 Node 的安装示例：

```powershell
$env:PATH = 'C:\Apps\DeepSeekHarness\resources\runtime\primary-runtime\dependencies\node\bin;' + $env:PATH
node --version
npm ci
npm run build
node dist/cli.js init --root 'E:\path\to\project'
```

如果 PATH 中 npm 来自系统 Node，且不能正常调用，可用 Node 24 显式执行该安装的 `npm-cli.js`。不要将示例安装路径直接用于其他机器。

`init` 不覆盖已有配置。检查 `.bridge/config.json` 中的绝对路径：

- `codex.command`：实际 `codex.exe`。初始化前可设 `CODEX_DSH_CODEX_BIN`。
- `codex.sourceHome`：已登录的 `.codex` 目录。
- `dsh.command` / `dsh.args`：DSH Desktop 启动器可使用 `"command": "cmd.exe"`、`"args": ["/c", "C:\\Apps\\DeepSeekHarness\\resources\\runtime\\cli\\bin\\dsh.cmd"]`。安装路径含空格时需按 cmd 的引号规则配置；此示例路径没有空格。
- 对普通 JavaScript CLI 安装，初始化前可设置 `CODEX_DSH_DSH_NODE`、`CODEX_DSH_DSH_BIN` 和 `CODEX_DSH_DSH_MODULES`；这些变量用于 Node + JS 入口，不适用于 `.cmd` 启动器。
- `dsh.sourceHome`：已登录的 `.dsh` 目录；`dsh.modules`：安装了官方 bundles 的 `profiles\node_modules`。
- `allowedRoots`：允许派发任务的项目目录。更改配置后重启桥接服务。

桥接在 Windows 上使用目录 junction 和凭据文件副本创建隔离运行目录，不要求开发者模式。重新登录后，已有隔离目录中的凭据副本可能需要手动更新；不要公开 `.bridge` 内容。Windows 文件保护依赖账户 ACL，POSIX 的 0600/0700 权限位不生效。

Codex 子会话配置自动包含 `[windows] sandbox = "elevated"`，仍使用 workspace-write 和禁止审批。请先在普通 Codex 中完成 Windows 沙箱初始化。官方说明见 [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)。CLI 升级后执行 `npm run generate:codex` 重新生成对应协议类型。

## 验证和启动

Windows 上 DSH 的受限沙箱可能无法启动带 piped stdio 的嵌套子进程，包括 `node --test`。本机验证采用显式配置：

```powershell
$env:CODEX_DSH_DSH_SANDBOX = 'danger-full-access'
node dist/cli.js doctor
npm test
npm run smoke:live
node dist/cli.js start
node dist/cli.js health
node dist/cli.js examples
```

该变量必须在启动桥接服务的进程环境中设置；已启动的服务需要先停止再启动。默认仍为 `workspace-write`。也可以在 `.bridge/config.json` 的 `dsh.permissionMode` 中显式设置，该字段优先于 `CODEX_DSH_DSH_SANDBOX`。`danger-full-access` 关闭 DSH 子会话的沙箱限制，目录白名单只限制任务入口，不能代替文件访问隔离。只在你信任的项目和任务中显式启用。额外权限请求仍被桥接拒绝。

`doctor` 不调用模型；`smoke:live` 使用现有登录和额度，在 `work/live` 新临时 Git 项目中验证双向执行、同会话续接、宿主独立测试及已有文件保留。报告保存在 `work/live-report.json`。模型调用需要网络连接。

`start` 在后台启动，日志位于 `.bridge/service.log`，`stop` 停止服务。Windows 不支持 `launchd-install` / `launchd-uninstall`；本说明不配置开机自启。

## 连接主端客户端

```powershell
. .\.bridge\connections\tokens.ps1
```

将生成的 `.bridge/connections/codex.toml` 合并到主端 `.codex/config.toml`。从加载了令牌的环境启动新的 Codex 客户端进程。已运行的桌面应用不会自动获得新环境变量。

DSH 主端同样从该终端启动，并挂载生成的 overlay：

```powershell
& 'C:\Apps\DeepSeekHarness\resources\runtime\cli\bin\dsh.cmd' --profile web --patch 'E:\path\to\codex-dsh-mcp\.bridge\connections\dsh.patch.yml'
```

两个客户端使用不同令牌；不要把令牌粘贴到聊天、日志或提交中。子会话的隔离配置不挂载桥接 MCP。`examples` 只生成连接文件，不改写已有主端配置。

## Auto review 与 ACP 会话

已在临时隔离 ACP profile 中验证桌面版自带的官方 Auto review（DSH 0.2.1-rc.3）：pwsh、文件读写、`node --test`、同会话追加任务及退出进程后恢复会话均通过。独立宿主复验四个测试通过，原有文件保留。结果见 [Auto review 验证记录](auto-review-validation-results.json)。

该验证没有修改 DSH 源码。临时 profile 使用同一套桌面运行时模块，加载官方 Auto review，并在会话创建或恢复时选择 `auto`。不能把不同版本的外部模块与桌面包混用。桥接的正式实现沿用同一机制：隔离 ACP profile 加入官方 Auto review bundle，并加载一个只依赖运行中 DSH 服务、不导入其它 DSH 运行时包的会话初始化插件。

桥接现在支持通过 `.bridge/config.json` 的 `dsh` 字段启用 Auto review。使用桌面版自带运行时时，在保留现有启动器和登录路径的基础上添加：

```json
{
  "permissionMode": "auto",
  "moduleSource": "bundled"
}
```

`permissionMode` 支持 `read-only`、`workspace-write`、`danger-full-access`、`auto`，且显式配置优先于兼容变量 `CODEX_DSH_DSH_SANDBOX`；两者都未配置时默认 `workspace-write`。`auto` 从同一 DSH 运行时加载官方 `@deepseek-ai/dsh-experimental-auto-review` bundle，在新建和恢复会话时选择 `auto` preset，并把会话审批策略固定为 `never`，使审核拒绝保持最终结论而不是转交无人应答的交互审批。桥接启动时 `serve` 会先运行 `doctor` 预检；Auto 模式只有在运行时通过 stderr 确认会话已按此状态初始化后才继续。缺少确认时预检和任务都会失败，错误包含 `DSH_AUTO_REVIEW_NOT_ACTIVE`，不会静默退回未审核模式。

`moduleSource` 默认 `external`：把 `dsh.modules` 挂载为隔离 profile 的模块回退目录（兼容在 profile 中单独安装模块的旧式安装）。设为 `bundled` 时不挂载任何外部模块目录，完全使用所配置启动器自身安装的包与版本（桌面运行时 0.2.1-rc.3 自带官方 base、ACP 和 Auto review），以避免混用另一份模块。DSH 先按启动器安装、再按 profile 目录解析 bundle；`bundled` 直接排除了后一条回退路径。此模式下仍保留 `modules` 字段仅为兼容旧配置。普通 Node CLI 安装若把模块单独装在 `dsh.modules`，应保留 `external`。桥接不自动安装或升级 DSH 组件。

修改后运行 `node dist/cli.js doctor`，再执行 `npm run smoke:live`，最后停止并重新启动桥接服务。`doctor` 不调用模型；配置为 Auto 时，它还检查真实会话创建时的 Auto 激活确认。`smoke:live` 使用同一份配置，通过正式执行器验证双向任务及跨进程会话续接（第二轮在新的 DSH 子进程中恢复会话）；启用 Auto 时该流程会实际经过审核层。切换 `moduleSource` 会使用不同的隔离目录，请在旧任务结束后切换，旧目录中的会话不会自动迁移。把 `permissionMode` 从 `auto` 切到其他模式后，旧会话恢复时不再有审核层，请先结束相关任务。

Auto review 以完整主机权限执行审核通过的工具，会增加模型调用。审核拒绝和审核服务故障的真实模型路径尚未纳入自动测试；自动测试覆盖激活确认缺失时的阻断、权限模式优先序、隔离目录生成与 preset/审批固定，隔离真实运行时探针（不调用模型）验证了新建与恢复会话的激活确认。原有权限拒绝逻辑继续有效。

桌面 profile 中启用 Auto review 不会自动影响桥接的隔离 ACP profile。桥接使用独立 `DSH_HOME`，因此其会话默认也不会出现在主端 DSH 桌面会话列表；任务进度通过桥接的 `agent_list`、`agent_status` 和 `agent_wait` 查看。

桌面端独立会话展示尚未交付：当前 DSH 0.2.1-rc.3 的公开扩展点无法在桌面端实时只读查看另一个进程的 ACP 会话——桌面会话列表只读取本进程所在 `DSH_HOME` 的持久层；`session/follow` 对冷会话必然触发 resume，遇到执行器的写锁会得到 `session/writer-held`，而实时事件只在进程内广播；同时没有外部会话行插槽、跨进程会话变更源或只读会话视图。因此本仓库不发布包装私有控制器、轮询重放日志或写入镜像会话的观察插件。缺失的扩展点及最小 DSH 侧改动建议见 [桌面会话可见性](desktop-session-visibility.md)。
