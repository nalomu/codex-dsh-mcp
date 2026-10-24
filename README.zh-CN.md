# Codex ↔ DeepSeek Harness MCP 桥接

本机单用户任务服务。Codex 通过 MCP 派发独立 DSH 会话，DSH 通过同一服务派发独立 Codex 会话；可查进度、等待、取消和在原会话追加返工。两端都可主控，子会话没有桥接工具。

```text
Codex → /mcp/codex → 持久任务队列 → DSH ACP v1（stdio）
DSH   → /mcp/dsh   → 持久任务队列 → Codex App Server（stdio）
```

## 安装与启动

需要 macOS 或 Windows、Node.js 24+、Git、已登录的 Codex CLI，以及安装了官方 base / acp bundle 的 DSH。Windows 的运行时路径、沙箱及 PowerShell 操作见 [Windows 安装与验证](docs/windows.md)。MCP SDK 使用 v2；ACP SDK 包虽为 2.0.0，但导入的是默认稳定 **ACP v1** 入口，没有使用实验性 v2 协议。

```sh
npm ci
npm run build
node dist/cli.js init --root /absolute/project
node dist/cli.js doctor
node dist/cli.js start
node dist/cli.js health
node dist/cli.js examples
```

`init` 不覆盖已有配置；可多次传 `--root`。未注册任何业务项目，默认只允许初始化时明确给出的目录。默认配置位置为当前项目 `.bridge/config.json`；所有命令可传 `--config /absolute/config.json`，也可设置 `BRIDGE_CONFIG`。

启动前会检查 Codex 登录及生成类型版本、DSH 凭据文件、ACP v1 会话创建/关闭，以及配置模型是否实际出现在 ACP 返回的选择中。这个检查不调用模型；**真正的模型访问权限通过 live smoke 验证**。失败会阻止服务启动。

本机 DSH 如果没有在 PATH，`init` 会探测 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`。其他安装位置参见 `examples/config.example.json`。请为 `command`、`args` 和 `dsh.modules` 设置实际路径；不会自动下载或升级 DSH。

`codex.sourceHome` 只用于引用原登录文件；子会话使用独立 `CODEX_HOME`，关闭 Apps、插件、多 Agent，并在启动轮次前检查 MCP 清单为空。默认沿用官方 Codex 的模型选择，可在配置的 `codex.model` 指定账号可用模型；自定义模型提供方需要通过显式执行器配置另行接入，首版不复制用户全局 provider 配置。

DSH 使用独立 `DSH_HOME`，仅组合官方 base 与 ACP bundle；不会继承 Web/Desktop profile。只引用原 DSH 凭据存储和账户状态，模型明确由 `dsh.provider`、`dsh.model` 指定。执行器环境只继承必要的基础变量；额外模型凭据可通过各自 `env` 显式提供，不能传桥接令牌。

## 连接主端

`examples` 在 `.bridge/connections/` 生成配置片段及权限为 0600 的 `tokens.env`，不会在终端打印令牌。

1. 在启动主端客户端的终端执行 `source /absolute/codex-dsh-mcp/.bridge/connections/tokens.env`。
2. Codex：将生成的 `codex.toml` 条目合并进主端 `~/.codex/config.toml`，然后重新启动客户端。
3. DSH：使用生成的 `dsh.patch.yml` 作为**主端** profile overlay，例如 `dsh --profile web --patch /absolute/codex-dsh-mcp/.bridge/connections/dsh.patch.yml`。

使用桌面应用时，需要确保应用启动进程能读取对应环境变量；Finder 启动的应用不会自动继承上述终端变量。也可按客户端支持的方式配置 HTTP Authorization header。项目交付不会改写你的现有 Codex/DSH 主端配置。

两个端点使用不同令牌，并由 URL 决定调用身份，工具参数不能伪造身份或指定同端目标。服务仅监听 `127.0.0.1`，校验端口匹配的 Host、Origin 和 Bearer 令牌。`GET /health` 仅返回版本及存活状态，无任务或凭据数据。

## 使用工具

| 工具             | 主要输入                               | 返回                            |
| ---------------- | -------------------------------------- | ------------------------------- |
| `agent_run`      | `prompt`, `cwd`, `idempotencyKey`      | `{task}`，立即返回              |
| `agent_status`   | `taskId`, `after=0`, `limit=100`       | task、事件、nextCursor、hasMore |
| `agent_wait`     | `taskId`, `after=0`, `timeoutMs=25000` | 新事件、终态或超时后的状态      |
| `agent_continue` | `taskId`, `prompt`, `idempotencyKey`   | 原任务的新轮次                  |
| `agent_cancel`   | `taskId`                               | 执行器已停止后的 task           |
| `agent_list`     | `cursor=0`, `limit=20`                 | 本调用方任务、nextCursor        |

创建示例：

```json
{
  "prompt": "实现订单金额校验并运行相关测试；保留已有修改，不提交 Git。",
  "cwd": "/absolute/project",
  "idempotencyKey": "order-validation-001"
}
```

随后使用 `agent_wait`，每次传上次的 `nextCursor`，直至 `task.state` 为终态。分页尚有事件时先继续读取事件，避免遗漏。需要返工时，对同一个 `taskId` 调用 `agent_continue`，传新的幂等键；已存在的 sessionId 保持不变。

`agent_run` 的幂等键按调用方隔离；同键同请求返回原任务，同键不同请求报 `IDEMPOTENCY_CONFLICT`。`agent_continue` 的键按任务隔离。运行中的会话不能接受不同键的新轮次，会报 `TASK_BUSY`。每轮的结果、错误及 Git 快照都留在 `rounds` 中。

状态为 `queued / running / succeeded / failed / cancelled / interrupted`。`succeeded` 表示执行轮次正常结束；是否符合需求必须由主任务检查实际文件和测试决定。权限拒绝、协议失败、异常断线或异常停止原因均不会伪装成功。

## 共享文件、权限与恢复

- 子任务直接修改共享项目。同一 Git 工作树（包括其子目录及符号链接别名）的桥接任务串行；非 Git 目录按真实目录和嵌套关系串行。
- 子任务排队或执行期间，主任务暂停写同一项目。锁只覆盖通过本服务调度的任务，无法阻止外部编辑器或其他进程修改文件。
- 不自动提交、回滚、合并、清理目录。Git 快照记录执行前后状态、差异统计和原有未提交文件；共享目录的差异不宣称全部由子任务产生。非 Git 项目明确标记无快照。
- 路径必须为允许根目录以内的真实绝对目录；目录白名单控制派发入口，实际文件/Shell 权限由 Codex 的 workspace-write 沙箱和 DSH 的官方 sandbox-policy/fs-sandbox 实现。
- 额外权限请求默认拒绝并记录事件。没有人工审批界面，不自动扩权。DSH 还禁用插件安装、权限模式切换和子 Agent 工具；Codex 禁用 Apps、插件和多 Agent。对子会话不挂载桥接 MCP，防止继续跨端委派。
- 首先发协议取消，最多等待 2 秒；随后终止整个执行器进程组，确认进程组消失才释放目录锁。取消保留已经完成的文件修改。
- 主聊天关闭、MCP 请求取消或 HTTP 断开不会取消任务。SQLite 独立保存任务、会话 ID 和带递增序号的事件；服务重启将未完成任务标记 `interrupted`，不自动重放。
- 执行器由独立进程组和父进程看护程序管理，服务崩溃时看护程序会停止该组。重启先等待旧组退出，无法确认则拒绝恢复。停止失败的项目保持隔离，不能继续排任务。
- 对 `interrupted` 任务显式继续时，优先恢复原会话；若中断发生在会话创建前，则创建新会话开始用户新给的轮次。DSH ACP 不回放旧事件，本服务仅能返回自行保存的事件。
- 公开发布时还应排除 `work/`、`evidence/` 和个人安装说明。`.bridge/` 中含访问令牌、任务文本和登录引用，请保持目录 0700、配置 0600；默认 Git 忽略，不放入源码包。

## 后台运行

```sh
node dist/cli.js start
node dist/cli.js stop
./scripts/install-launchd.sh --config /absolute/codex-dsh-mcp/.bridge/config.json
./scripts/uninstall-launchd.sh --config /absolute/codex-dsh-mcp/.bridge/config.json
```

安装 LaunchAgent 前先停止手动运行的实例。脚本写入用户 `~/Library/LaunchAgents/local.codex-dsh-bridge.plist`，设置登录启动和异常退出重启；不会复制令牌到 plist。卸载保留任务数据库和配置。可先用 `node dist/cli.js launchd-install --dry-run` 查看 plist。日志为 `.bridge/service.log`，登录路径和环境变化后需重装 LaunchAgent。

## 验证与维护

```sh
npm test                    # 构建 + 模拟协议/实际 HTTP/进程生命周期测试，不调用模型
npm run smoke:live          # 新临时 Git 项目，双方真实模型各执行与继续一轮
npm run generate:codex      # Codex CLI 升级后，重新生成本机版本协议类型
npm run build
```

`smoke:live` 使用现有登录和额度，产物放在 `work/live/`，原始报告在 Git 忽略的 `work/live-report.json`；独立运行生成的测试并检查预先存在的 dirty.txt 没被覆盖。模拟协议测试通过不能代替真实模型验收，实际结果见 `VALIDATION.md`。

Codex 升级后预检会检查类型版本，防止使用旧版协议静默运行。DSH 仍处于快速迭代阶段；升级后重新执行 doctor、npm test 和 live smoke，不自动修改已安装运行时。

官方依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[DSH ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.zh.md)、[DSH MCP Client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)、[MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)。

开源版采用 [MIT 许可证](LICENSE)，生成的 Codex 类型另遵循其 Apache-2.0 来源声明，详见 [NOTICE](NOTICE)。隐私边界见 [SECURITY.md](SECURITY.md)。
