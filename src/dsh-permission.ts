import type { Config } from './types.js';
import { dshPermissionMode } from './runtime.js';
import { withDeadline } from './deadline.js';

/** Exact stderr line the Auto review helper writes once a session is pinned. */
export const AUTO_REVIEW_READY = 'CODEX_DSH_AUTO_REVIEW_READY';

/**
 * Detect the Auto review activation acknowledgement of one runtime process.
 * With `auto` configured, `verify()` blocks the caller until the helper plugin
 * confirms that a session was published with the official reviewer loaded and
 * final denials pinned. A missing acknowledgement is a hard failure: the
 * bridge never falls back to an unreviewed or partially configured mode.
 */
export function dshPermissionGuard(config: Config, timeoutMs = 5000) {
  let ready: () => void = () => {};
  let acknowledged = false;
  const active = new Promise<void>((resolve) => {
    ready = resolve;
  });
  return {
    get acknowledged() {
      return acknowledged;
    },
    stderr(line: string) {
      if (line.trim() !== AUTO_REVIEW_READY) return;
      acknowledged = true;
      ready();
    },
    async verify() {
      if (dshPermissionMode(config) !== 'auto') return;
      await withDeadline(
        active,
        timeoutMs,
        'DSH_AUTO_REVIEW_NOT_ACTIVE: the official Auto review integration did not confirm activation; load the matching @deepseek-ai/dsh-experimental-auto-review from the same DSH runtime and check dsh.moduleSource',
      );
    },
  };
}
