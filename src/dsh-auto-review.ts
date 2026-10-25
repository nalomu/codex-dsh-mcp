// Loaded by DSH's Cordis loader, with no imports from a different DSH runtime.
// Keep this module free of runtime imports from the bridge's dependency tree.
//
// The official Auto review bundle publishes the current-session-only `auto`
// permission preset and prepends its per-call review gate while it is loaded.
// The bridge starts `dsh --profile acp` with that official bundle, so a session
// may accept work only after Auto is selected and final reviewer denials are
// pinned. Initialization runs on `session/created`, DSH's synchronous session
// publication boundary:
//
// - The core `@deepseek-ai/dsh-permission-presets` plugin fills initial
//   permission facts in the same hook, and DSH documents that a synchronous
//   throw vetoes publication and rolls it back. Work therefore either starts
//   with the complete permission state or does not start at all.
// - `permissionPresets.set(session, 'auto')` is the service's public write path
//   for a session-level preset. It resolves the preset first, so it throws
//   unless the loaded official Auto review bundle registered `auto`.
// - `approval/policy` is a core session event folded by `ctx.approval`. Its
//   canonical writer appends exactly that event after validating the policy.
//   This plugin must not import a second DSH runtime's packages, so it appends
//   the same event and verifies the folded value before acknowledging.
//
// ACP has no interactive approval answerer in this bridge, so `never` keeps a
// reviewer denial final instead of falling through to an ask nobody answers.
export const name = 'bridge-auto-review';
export const inject = ['approval', 'permissionPresets', 'sessions'];

/** Exact stderr line the bridge waits for before it releases a prompt. */
export const READY = 'CODEX_DSH_AUTO_REVIEW_READY';

type ApprovalPolicy = 'ask' | 'never';

interface Session {
  append(type: 'approval/policy', data: { policy: ApprovalPolicy }): void;
}

interface Context {
  approval: {
    overrideOf(session: Session): ApprovalPolicy | undefined;
  };
  permissionPresets: {
    current(session: Session): string;
    set(session: Session, name: string): void;
  };
  sessions: {
    list(): Session[];
  };
  on(event: 'session/created', listener: (session: Session) => void): unknown;
}

const detail = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Select Auto and pin final denials on one published session, then acknowledge. */
function initialize(ctx: Context, session: Session) {
  if (ctx.permissionPresets.current(session) !== 'auto') {
    try {
      ctx.permissionPresets.set(session, 'auto');
    } catch (error) {
      throw new Error(
        'DSH_AUTO_REVIEW_NOT_ACTIVE: the official Auto review bundle did not register the "auto" preset from this DSH runtime: ' +
          detail(error),
      );
    }
  }
  if (ctx.approval.overrideOf(session) !== 'never') {
    try {
      // The canonical writer validates the policy and appends this exact
      // event; the append is the dependency-free equivalent. The folded value
      // is checked below so a contract change fails closed.
      session.append('approval/policy', { policy: 'never' });
    } catch (error) {
      throw new Error(
        'DSH_AUTO_REVIEW_NOT_ACTIVE: the final approval fallback could not be pinned to "never": ' +
          detail(error),
      );
    }
  }
  if (ctx.permissionPresets.current(session) !== 'auto')
    throw new Error(
      'DSH_AUTO_REVIEW_NOT_ACTIVE: permission preset "auto" did not take effect',
    );
  if (ctx.approval.overrideOf(session) !== 'never')
    throw new Error(
      'DSH_AUTO_REVIEW_NOT_ACTIVE: final approval policy is not "never"',
    );
  process.stderr.write(READY + '\n');
}

export function apply(ctx: Context) {
  // New and restored sessions are both announced through this synchronous
  // publication hook, before ACP can accept a prompt for them.
  ctx.on('session/created', (session) => initialize(ctx, session));
  // A session published while this row was still activating cannot be seen by
  // its listener. The bridge holds the prompt until it observes the
  // acknowledgement, so pinning such a session here is still ahead of any
  // model work; a failure fails the plugin instead of leaving it unreviewed.
  for (const session of ctx.sessions.list()) initialize(ctx, session);
}
