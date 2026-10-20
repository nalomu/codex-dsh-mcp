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

## Limits of this evidence

These checks cover the stated runtime versions. Changes to Codex/DSH may require regenerated types or adapter updates. The LaunchAgent plist has been syntax-checked; login-time service installation is not part of the automated tests. Shared-directory snapshots do not prove exclusive attribution of file changes, and they do not prevent external editors writing concurrently.
