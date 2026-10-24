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

该变量必须在启动桥接服务的进程环境中设置；已启动的服务需要先停止再启动。默认仍为 `workspace-write`。`danger-full-access` 关闭 DSH 子会话的沙箱限制，目录白名单只限制任务入口，不能代替文件访问隔离。只在你信任的项目和任务中显式启用。额外权限请求仍被桥接拒绝。

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

该验证没有修改 DSH 源码。临时 profile 使用同一套桌面运行时模块，加载官方 Auto review，并在会话创建或恢复时选择 `auto`。不能把不同版本的外部模块与桌面包混用。

**这是一项可行性验证；当前生产桥接尚未接入 Auto review，`smoke:live` 也不会自动测试它。** 正式启用仍需适配桥接的 profile 生成和会话初始化。Auto review 以完整主机权限执行审核通过的工具，会增加模型调用；本次验证没有覆盖审核拒绝或审核服务故障路径。

桌面 profile 中启用 Auto review 不会自动影响桥接的隔离 ACP profile。桥接使用独立 `DSH_HOME`，因此其会话默认也不会出现在主端 DSH 桌面会话列表；任务进度通过桥接的 `agent_list`、`agent_status` 和 `agent_wait` 查看。
