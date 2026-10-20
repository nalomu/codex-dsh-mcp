# Contributing

Use macOS and Node.js 24+. Install with `npm ci`, then run `npm test`, `npm run format:check`, and `npm run privacy:check` after staging changes. Automated tests use deterministic protocol peers and do not need a Codex/DSH installation or model credentials.

Keep changes focused. Add behavior-level regressions for task ownership, scheduling, cancellation, crash recovery, protocol compatibility or credential handling when changing those boundaries. Preserve existing unrelated project edits.

Generated declarations in `src/generated/codex/` come from the version recorded in `src/generated/codex-version.json`; regenerate them with the official CLI rather than editing them manually. Retain upstream license notices.

Real-model checks are explicitly opt-in via `npm run smoke:live`. Keep raw output, task databases, local paths and credentials out of commits and issues. A sanitized summary may record runtime versions, scenarios and pass/fail outcomes.
