# Security and privacy

This release targets one trusted user on a local macOS machine. It binds only to loopback and validates Host, Origin and a distinct token per caller. It is not a multi-tenant service and should not be exposed through a network tunnel or public proxy.

## Runtime boundaries

- An allowlisted real path controls which directory may be dispatched. It does not itself sandbox an agent. File and shell restrictions are enforced by each official runtime's workspace-write policy.
- Bridge-owned execution sessions do not receive bridge MCP tools. Codex Apps, plugins and multi-agent support are disabled and its MCP inventory is checked before execution. DSH uses an isolated official base/ACP profile with plugin management, permission switching and delegated-agent tools disabled.
- These configuration controls prevent ordinary recursive delegation through the bridge. They are not a security boundary against a deliberately hostile local user or every possible shell action. Runtimes, project instruction files and configured executables must be trusted.
- Directory locks cover service-managed tasks only. Stop editing a shared project while it is delegated; the service cannot lock out unrelated editors.
- Permission escalation is denied. Cancellation and recovery keep a directory locked until its worker process group has exited. Processes intentionally detached into another OS session are outside process-group supervision.

## Credentials and local data

`.bridge/` contains caller tokens, task text, results and runtime state. Keep it private (directory 0700, configuration 0600). Child homes reference provider login state instead of committing or embedding credentials. Credentials supplied through executor environment configuration are local secrets too.

Do not commit `.bridge`, `.env` files, private keys, SQLite files, raw model transcripts, temporary projects or a personal installation report. They are ignored by default. `npm run privacy:check` scans indexed files for likely credentials and personal machine paths. An optional `--secrets-file /local/secret-values.json` accepts a private JSON string array for an additional exact-value check without printing those values. This check is a release aid, not a guarantee that arbitrary personal information can always be detected automatically.

The public repository contains only synthetic fixtures and a sanitized validation summary. Live smoke keeps raw reports under ignored `work/` and may write model-generated text containing local paths there.

## Reporting

Use GitHub private vulnerability reporting if it is enabled on the repository. Do not put credentials, private project files or raw task databases into a public issue. If private reporting is unavailable, open a minimal public issue requesting a private reporting channel without disclosing the vulnerability or sensitive data.
