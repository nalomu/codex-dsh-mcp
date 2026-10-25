# Desktop session visibility for bridge ACP sessions

Status: **not implemented on DSH 0.2.1-rc.3.** No supported public extension point
lets the Desktop UI list and follow, live and read-only, a session owned by a
different DSH process. This page records what was verified, which workarounds were
rejected, and the minimal upstream changes that would unblock the feature.

The requested direction has since changed: use compact bridge reports, a durable
supervisor inbox, and on-demand detailed logs instead of Desktop session display.
The Desktop observer prototype was never installed. Its local test homes,
scripts and stale compiled artifacts have been removed; existing user plugins,
Auto review settings and the intentional bridge MCP connections are preserved.

## Goal

The bridge runs each DSH delegation in an isolated `dsh --profile acp` child
process. The requested outcome is that those child sessions appear independently in
the Harness Desktop session list and can be opened to watch tool calls, output and
live progress, while:

- the Desktop view never takes write ownership from the ACP executor session;
- the child session inherits neither the bridge MCP server nor delegation tools
  (no recursive delegation).

## What the installed runtime provides

Checked against the running Host and the installed `0.2.1-rc.3` packages
(`@deepseek-ai/dsh-api-session-controller`, `@deepseek-ai/dsh-session-query`,
`@deepseek-ai/dsh-session-persistence-jsonl`, `@deepseek-ai/dsh-client-*`,
`@deepseek-ai/dsh-desktop-host`, `@deepseek-ai/dsh-acp`).

- The Desktop session list is `sessionController.list()` → `sessionQuery.listSessions()`
  → the Desktop process's own `sessionPersistence.list()`. Profiles change plugin
  composition, not the session store: every profile under one `DSH_HOME` shares
  `$DSH_HOME/sessions`, while another `DSH_HOME` is invisible to the list.
- `sessionPersistence.open(id, 'read')` is explicitly cross-process safe: a read
  handle works while another process holds the write handle of the same session.
- `session/page` is a cold, non-activating history read; `sessionQuery` exact reads
  replay whole logs and expose no subscription.
- Session rows reach the browser through `session/list` plus the `api-session/*`
  Host events, which the controller derives only from this process's
  `session/created|disposed|event|...` and `agent/*` facts. The Client refreshes the
  full list only on a new connection generation (page load/reconnect).
- Client row surfaces are decoration only (`sidebar.session.row.leading|hover`,
  `sidebar.workspaces.session.menu.item|row.action`); `sidebar.workspaces` is a
  whole-region single slot with `replaceRisk: shadows-shipped-ui`. A separate panel
  can be contributed with `sidebar.panellist` + a `main` key, but it is not a
  session-list row.
- `@deepseek-ai/dsh-acp` is an automation-only, stdio-hard-wired app profile; it has
  no transport configuration and intentionally omits DSH presentation data.
- The Desktop Host launch token is minted per process in memory and handed only to
  the Electron shell over IPC. `/connect` always yields an `owner` principal, and
  non-owner peers can only be created in-process. A separate local process therefore
  cannot call the stock Remote API in this release.

## The verified gap

1. **No non-promoting follow.** `session/follow` unconditionally promotes a cold
   ordinary session after the opening snapshot (background resume). When another
   process owns the session, that resume fails with `session/writer-held`, the
   failure is reported as `api-session/error`, and the follower stream only carries
   this process's events — so the view freezes at the snapshot. `SessionFollowRequest`
   has no observe/read-only option.
2. **No cross-process session change source.** The follow buffer is fed only by
   process-local `session/event`, `session/created` and `agent/assistant-stream`.
   `sessionPersistence` exposes no `watch`/tail seam and there is no `sessionSource`
   registry a plugin could compose.
3. **No live list update for foreign writes.** `api-session/*` is emitted only from
   in-process facts, and the Client has no list-change subscription, so a session
   materialized by another process appears only after a page reload or Host restart.
4. **No view-only UI mode and no additive session-row extension.** Nothing can
   register an external session row, and the shipped session page has no read-only
   state that disables prompt/queue/rename/cancel while another process executes.
5. **No supported external API caller.** See the launch-token/`owner` restriction
   above.

## Rejected workarounds

These were considered and deliberately not shipped:

- **Wrapping private controller members** (`sessionController.history`,
  `controller.listState`, `controller.agents.resolveAgent`), polling
  `sessionQuery.readSession` to fake a tail, and synthesizing `api-session/added`
  frames. Version-fragile, unsupported, and it hides writer ownership instead of
  reporting it.
- **Sharing the Desktop `DSH_HOME`** with the ACP child under a separate profile.
  Layout-compatible, but only produces cold sessions after a reload, fails live
  follow with `writer-held`, and the shared JSON storage has no documented
  cross-process locking for settings/projection-cache writes.
- **Synthetic mirror sessions** in the Desktop store. This duplicates data, writes
  generated history into the user's real session store, and is not a read-only view
  of the executor session.
- **Mounting the ACP app in Desktop.** Transport is hard-wired to stdio and the
  package is explicitly automation-only.

## Minimal upstream change A — read-only observation (keeps the ACP executor)

This is the smallest change that satisfies the stated requirement without moving
execution into the Desktop process. Four pieces, in dependency order:

1. **Non-promoting follow.** Add an option to `SessionFollowRequest` (for example
   `mode: 'observe'`, or `detach: true`) that yields the opening snapshot and then
   tails a read-only source without calling `promote()`. In the controller, this is
   one conditional around the promotion branch; a foreign-owned session is already
   readable through the persistence `read` handle.
2. **Cross-process change source.** Add a seam the controller can subscribe to, so a
   follow stream can be fed by external appends:
   `SessionPersistence.watch(id, signal): AsyncIterable<readonly SessionEvent[]>` for
   the JSONL backend (file watch + incremental offset reads, validated like a normal
   read handle), or a Host `sessionSource`/`sessionWatch` service composed from it.
   This avoids polling and whole-log replay.
3. **List visibility for watched sessions.** Emit `api-session/added`/`activity`
   (or a dedicated list-delta event) when a watched foreign session materializes or
   advances, and subscribe the Client to it so a row appears without a reload.
4. **View-only session mode.** When a session is opened while foreign-owned, render
   the normal Conversation read-only: hide/disable the composer, queue edits, model
   selection, rename, fork and cancel, and label the executor. This is the UI layer
   on top of (1)–(3); a first version can ship without (3) if an explicit "refresh"
   is acceptable.

A supported row extension is not strictly required if foreign sessions are listed
through the normal catalog, but a documented "external session" state is needed so
the UI can present the executor and the read-only posture.

**Acceptance:** a bridge task's session appears in the Desktop list while running;
opening it shows tool calls and output as they are appended; the ACP child keeps
write ownership throughout (no `writer-held`, no second agent); the child's toolset
contains no bridge MCP and no delegation tools; a recursive delegation attempt is
impossible.

## Alternative B — in-Host execution (zero DSH source change today, larger bridge change)

Instead of observing the ACP child, make the Desktop Host own the sessions and let
the bridge drive them through a Host extension:

- A Host-only bundle installed in the Desktop profile can register a loopback
  transport (`webServer.register`/`registerUpgrade`) with its own bearer token and
  drive native Host sessions through the public service methods
  `sessionController.create/prompt/cancel/follow/page`, `sessionQuery`, and the
  `session/event` / `agent/assistant-stream` events. Sessions created there are
  native: they appear in the sidebar live, open without a writer conflict, and can
  be watched while the bridge runs.
- Isolation is a dedicated `agent-preset` row whose child list contains no
  `mcp-client` and no `tool-subagent*`/workflow rows, plus a preset-scoped
  `ctx.tools.restrict({ allow: [] })` child plugin that masks inherited Host-plane
  tools (including the bridge MCP tools) while the preset's own tool rows remain
  visible.
- This changes the bridge's execution model: it needs a second transport in
  `src/adapters` and a decision about approval/sandbox parity, and the Auto review
  profile used by the isolated ACP child would no longer apply to those sessions.
  It is therefore a product decision, not a drop-in fix.

If upstream wants to support this architecture the clean way, add an **API-caller
credential bootstrap** to `@deepseek-ai/dsh-client-connection` (a durable
owner-provisioned token file accepted by `/connect` in addition to the in-memory
launch token, ideally restricted by `dsh-api-remote-access`). The bridge could then
use the stock Remote API like a browser peer, with no custom transport bundle.

## General direction C — session-source registry

For "any DSH store/source can be listed in Desktop", add a session-source registry
that feeds `sessionQuery.listSessions`/`observeSession` plus the watch seam from
(A.2). That is a larger design change than A or B and is not required for the bridge
case.

## Verification status

- Verified by reading the installed package sources and by inspecting the running
  Host (`cordis_inspect_list` / `cordis_inspect_query`, DSH 0.2.1-rc.3).
- Not executed end-to-end: the required API does not exist in this release.
- No DSH source, `app.asar`, profile patch or session data was modified to produce
  this report; no observer plugin was installed.
