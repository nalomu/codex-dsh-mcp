# Codex ↔ DeepSeek Harness MCP bridge

[中文说明](README.zh-CN.md) · [Validation](VALIDATION.md) · [Security](SECURITY.md)

A local, single-user task bridge. Either Codex or DeepSeek Harness can delegate work to the other agent, read progress, wait, cancel, and continue the original execution session. Both agents use their own official runtime and login.

```text
Codex ── MCP /mcp/codex ──┐                 ┌── ACP v1 ── DSH session
                         ├── task service ┤
DSH   ── MCP /mcp/dsh ────┘                 └── App Server ── Codex session
```

The task service runs independently of the caller. Closing a chat or losing an MCP connection does not cancel its tasks. Delegated sessions have no bridge tools; v1 permits one delegation level.

## Requirements

- macOS and Node.js 24 or later. Other platforms are not supported in this release.
- Git, an authenticated Codex CLI, and DeepSeek Harness with its official base and ACP bundles installed.
- Tested runtime versions: Codex CLI `0.162.1`, DSH `0.2.0-rc.2`. The ACP SDK package version is `2.0.0`, but this project imports its stable **ACP v1** entry point, not experimental ACP v2.

## Quick start

```sh
git clone https://github.com/nalomu/codex-dsh-mcp.git
cd codex-dsh-mcp
npm ci
npm run build
node dist/cli.js init --root /absolute/project
node dist/cli.js doctor
node dist/cli.js start
node dist/cli.js health
node dist/cli.js examples
```

`init` creates `.bridge/config.json` with two random caller tokens and never overwrites an existing configuration. Repeat `--root` to authorize additional projects. All commands accept `--config /absolute/config.json`; `BRIDGE_CONFIG` also selects a configuration file.

`doctor` checks Codex login/version and creates/closes a real DSH ACP session, verifying the selected model configuration. It does **not** verify inference access. `serve` runs this preflight before accepting work.

If DSH is not on PATH, initialization probes its standard profile installation. For another installation, update `dsh.command`, `dsh.args` and `dsh.modules` using [the example configuration](examples/config.example.json). The ACP runtime does not inherit a Web/Desktop profile. Set `dsh.provider` and `dsh.model` explicitly. Custom Codex model-provider configurations are not automatically copied into child homes.

## Connect both callers

`examples` writes client snippets and a private `tokens.env` under `.bridge/connections/`. It does not edit existing client configuration or print tokens.

1. Source `/absolute/codex-dsh-mcp/.bridge/connections/tokens.env` in the environment that launches your callers.
2. Merge `codex.toml` into your main Codex configuration, then restart that client.
3. Apply `dsh.patch.yml` to your main DSH profile:

```sh
dsh --profile web --patch /absolute/codex-dsh-mcp/.bridge/connections/dsh.patch.yml
```

The caller endpoints are `http://127.0.0.1:43219/mcp/codex` and `/mcp/dsh`, with different Bearer tokens. The endpoint determines caller identity; tool inputs cannot impersonate the other caller. Desktop apps launched from Finder do not automatically inherit terminal environment variables: launch them with the required environment or configure their supported Authorization header mechanism.

## Task tools

| Tool             | Input                                | Behavior                                                   |
| ---------------- | ------------------------------------ | ---------------------------------------------------------- |
| `agent_run`      | `prompt`, `cwd`, `idempotencyKey`    | Immediately returns an independent task on the other agent |
| `agent_status`   | `taskId`, `after`, `limit`           | State, rounds, result, Git snapshots, and paginated events |
| `agent_wait`     | `taskId`, `after`, `timeoutMs`       | Waits at most 25 seconds for events or a terminal state    |
| `agent_continue` | `taskId`, `prompt`, `idempotencyKey` | Starts another round in the original session               |
| `agent_cancel`   | `taskId`                             | Cancels queued work or stops the running process group     |
| `agent_list`     | `cursor`, `limit`                    | Lists tasks owned by the authenticated caller              |

Example `agent_run` input:

```json
{
  "prompt": "Implement the validation rule, preserve existing edits, run its tests, and do not commit.",
  "cwd": "/absolute/project",
  "idempotencyKey": "validation-001"
}
```

Pass the returned `nextCursor` into subsequent status/wait requests. States are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `interrupted`. A succeeded execution is still subject to the caller's code review and independent tests. A different continuation cannot be submitted while a round is running.

## Execution and recovery

- Shared directories are modified directly. Tasks targeting the same Git worktree, directory aliases, or overlapping directories run serially. The caller must stop editing that project until delegation ends; external editors are outside the service's lock.
- The bridge does not automatically commit, merge, reset, revert or clean files. Before/after Git snapshots identify pre-existing edits and do not attribute every shared-directory change to one task.
- Extra permission requests are denied and reported. Child runtimes use workspace-write policies, isolated configuration homes, no bridge MCP, and disabled plugin installation/delegation capabilities. See [security boundaries](SECURITY.md).
- Cancellation first requests a protocol stop, then terminates the worker process group if necessary. The directory remains locked until the group has stopped. Already completed edits remain on disk.
- SQLite stores tasks, rounds, session identifiers and cursor-based events. An OS-backed daemon lease prevents two schedulers sharing a state directory. Worker supervision stops orphan groups after a daemon crash.
- Restart verifies old worker groups have exited and marks unfinished work interrupted. It never replays a writing task automatically. Explicit continuation resumes its saved session; interrupted admission without a session can start a new session with the newly supplied request.

## Background operation

```sh
node dist/cli.js start
node dist/cli.js stop
node dist/cli.js launchd-install --dry-run
./scripts/install-launchd.sh --config /absolute/codex-dsh-mcp/.bridge/config.json
./scripts/uninstall-launchd.sh --config /absolute/codex-dsh-mcp/.bridge/config.json
```

Stop a manually started instance before installing the LaunchAgent. The scripts manage the current user's `local.codex-dsh-bridge` LaunchAgent. Uninstall preserves configuration and task data. Stop requests use an authenticated local endpoint rather than trusting a stale PID file. For a LaunchAgent-managed instance, uninstall/boot out the agent to prevent its KeepAlive policy from restarting it.

## Development

```sh
npm test                  # build + deterministic HTTP/protocol/process tests; no model calls
npm run format:check
npm run privacy:check     # inspect the indexed Git snapshot; never prints secret values
npm run smoke:live        # opt-in: real inference, new temporary Git project
npm run generate:codex    # regenerate protocol declarations after a Codex CLI upgrade
npm run build
```

Live smoke uses existing credentials and model quota. Runtime data, raw reports, logs, local installation notes and temporary projects are Git-ignored. Publish a sanitized validation summary rather than raw model transcripts.

## License and upstreams

Original bridge code is [MIT-licensed](LICENSE). Generated Codex protocol declarations retain their upstream Apache-2.0 notice; see [NOTICE](NOTICE).

This is an independent project, not an official OpenAI or DeepSeek product. Built on [Codex App Server](https://learn.chatgpt.com/docs/app-server), [DSH ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.zh.md), [DSH MCP Client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md), and the [official MCP SDK](https://ts.sdk.modelcontextprotocol.io/v2/).
