# Validation

Reference environment: macOS, Node.js 24.19.0, Codex CLI 0.162.1, DSH 0.2.0-rc.2.

## Automated coverage

`npm test` builds the service and exercises the real MCP HTTP layer and both production runtime adapters against deterministic protocol peers. No inference credentials are required.

Coverage includes caller ownership and separate tokens, Host/Origin validation, task idempotency and busy-session behavior, directory aliases/overlap, event cursors, continuation, preservation of dirty files, permission denial, refusal of inherited MCP, cancellation of process-group descendants, daemon SIGKILL and restart without replay, verified quarantine recovery, scheduler lease exclusion, UTF-8 chunk boundaries, split-log credential redaction, and uncooperative-operation deadlines.

The CI workflow repeats build/tests, formatting and the staged-file privacy scan on macOS with Node.js 24. Refer to the latest CI run for the current result; this document is not a substitute for executing the checks.

## Real runtime checks

On 2026-10-20, both directions completed an opt-in real-model smoke test in a newly created temporary Git project:

| Direction   | First round                                 | Same-session continuation            | Independent host checks                       |
| ----------- | ------------------------------------------- | ------------------------------------ | --------------------------------------------- |
| Codex → DSH | Implement `add` and positive/negative tests | Add `subtract` and subtraction tests | Six tests passed; behavior assertions passed  |
| DSH → Codex | Implement `add` and positive/negative tests | Add `subtract` and subtraction tests | Four tests passed; behavior assertions passed |

Both preserved a pre-existing dirty file. DSH ACP handshake/session creation/close and Codex login/protocol-version checks also passed. Live execution used the task manager and production adapters; automated tests cover their MCP HTTP entry points.

The final open-source build passed all 15 automated tests and a fresh bidirectional real-model smoke after the hardening changes. The sanitized outcomes are recorded in [docs/validation-results.json](docs/validation-results.json). The repository deliberately excludes raw transcripts, execution-session identifiers, personal directories, account information and local installation state.

## Windows validation

On 2026-10-25 (Asia/Shanghai), Windows with Node.js 24.21.0 and Codex CLI
0.162.0-alpha.17.2 passed all 15 automated tests and all five doctor checks.
Both real-model directions completed two rounds (initial implementation and
continuation); independent host tests passed four tests per direction, and both
preserved the pre-existing dirty file. These live checks use the task manager
and production adapters. Separately, both authenticated MCP HTTP endpoints
passed SDK connection, six-tool discovery, and `agent_list` checks against the
running background service.

DSH used explicit `CODEX_DSH_DSH_SANDBOX=danger-full-access`; Codex retained
workspace-write with the elevated Windows sandbox. This does not establish
DSH workspace-write compatibility for nested piped subprocesses. Windows test
cleanup retries briefly occupied temporary directories. See
[sanitized Windows results](docs/windows-validation-results.json) and
[Windows setup](docs/windows.md). Main desktop client configuration/restart
is separate from these SDK endpoint checks.

### Auto review feasibility on Windows

On 2026-10-25 (Asia/Shanghai), a temporary isolated ACP profile loaded the
official Auto review bundle from the Desktop runtime, DSH 0.2.1-rc.3. It selected
`auto` on session creation/restoration and used `never` for final approval
fallback. Initial implementation, same-session continuation, and a fresh-process
resume all completed. PowerShell calls, file edits, and nested `node --test`
execution succeeded; independent host verification passed four tests and
behavior assertions, and the pre-existing dirty file was preserved.

No DSH source changes were needed for this probe. The bridge now exposes the same
setup through `dsh.permissionMode: "auto"` plus `dsh.moduleSource: "bundled"`:
it loads the official Auto review bundle into its isolated ACP profile, selects
Auto on both session creation and restore, pins the final approval fallback to
`never`, and blocks preflight or execution when the runtime does not confirm
activation (`DSH_AUTO_REVIEW_NOT_ACTIVE`). Activation for new and restored
sessions was re-verified against the real Desktop runtime without inference.
Reviewer denial and reviewer failure paths were not tested with a real model. See
[sanitized Auto review results](docs/auto-review-validation-results.json).

Final implementation check (2026-10-25, Windows, Node.js 24.21.0): the finished
bridge code passed the build, the complete 21-test suite, and the staged-snapshot
privacy scan. A no-inference `doctor` run against the Desktop launcher with
`permissionMode: "auto"` and `moduleSource: "bundled"` returned five of five checks,
including `permissions auto (Auto review activation confirmed)`. A fresh opt-in
live smoke with the same Auto configuration completed the Codex → DSH direction:
two rounds, the continuation resumed in a new DSH child process, the review layer
active, four independent host tests passed and the pre-existing dirty file was
preserved. In that same run the DSH → Codex direction did not pass: Codex's elevated
Windows sandbox helper could not launch from the non-interactive validation shell
(`Windows error 1223`), so the probe files were never created and only the host
check failed; that is the unchanged Codex adapter path, not the Auto review
integration. Reviewer denial and reviewer service-failure paths remain
unexercised.

## Caller-visible execution and feedback

On 2026-10-25 (Asia/Shanghai), the actual Codex MCP connection dispatched a
read-only DSH task, read incremental public messages and tool events with
`agent_wait`, and received the command input, output, and successful exit status.
After terminal completion, `agent_continue` restored the same DSH session,
executed a second command, and correctly recalled the prior file content. Host
inspection confirmed the fixture file was unchanged. No Desktop observer plugin
was required or installed.

The automated suite passed 22 tests, including both adapters' execution details
through MCP, structured credential redaction, omitted binary data, and bounded
output. Detail events are capped at 16,000 characters after redaction; command
output is available when reported by the runtime, not guaranteed per-character.
This provides observations through MCP and the caller's chat, not native Codex
subagent cards. This initial feedback probe used idle-task continuation; the
mailbox check below extends feedback to active tasks at turn boundaries.

## Compact reports and durable feedback mailbox

On 2026-10-25, the complete suite passed 28 tests, including chunked report
decoding, compact responses excluding logs and prompts, caller ownership,
idempotency, inbox persistence, turn-boundary delivery, same-session replies,
waiting cancellation, and both protocol adapters. The build passed as part of
the test run.

A real MCP client connected to the restarted background bridge and dispatched
a temporary DSH task. The worker asked a question and entered `waiting`.
`agent_send_message` delivered the answer, the same DSH session ran the requested
Node command, and the worker returned the expected marker with exit code zero.
Repeating the message idempotency key returned the same receipt. Host inspection
confirmed the original dirty file was unchanged. Seven MCP tools were exposed.
Default observations excluded raw tool/message/stderr events and round history.
The final compact response serialized to 3,268 characters versus 6,748 for the
full response in this small probe; this is a payload comparison, not a token-cost
benchmark. The ignored local report is `work/mailbox-live-report.json`.

Delivery occurs after the current execution turn, not during an active tool.
Detailed logs remain local and can be requested explicitly. The live mailbox
probe exercised Codex-to-DSH; the reverse adapter's report transport is covered
by the protocol tests, not by a new live Codex sandbox/UAC run. The production
DSH permission configuration was preserved; this probe does not establish Auto
review activation in that background service.

Cleanup removed the abandoned Desktop observer prototype, its isolated test
home/script/report, and stale compiled observer modules. Inspection found no
observer registration in either Desktop or Web, no observer process, and no
bridge login-startup script. Existing bridge MCP connections, Auto review,
credentials, backups, and task history were retained. No Desktop plugin was
installed or removed through private APIs.

## Limits of this evidence

These checks cover the stated runtime versions. Changes to Codex/DSH may require regenerated types or adapter updates. The LaunchAgent plist has been syntax-checked; login-time service installation is not part of the automated tests. Shared-directory snapshots do not prove exclusive attribution of file changes, and they do not prevent external editors writing concurrently.
