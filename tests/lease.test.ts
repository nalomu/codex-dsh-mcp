import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLease } from '../src/lease.js';

test('OS lease excludes competing schedulers even with stale or replaced PID diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-lease-'));
  let release: (() => Promise<void>) | undefined;
  try {
    await writeFile(
      join(root, 'daemon.lock'),
      JSON.stringify({ pid: 123456789 }),
    );
    release = await acquireLease(root);
    await writeFile(
      join(root, 'daemon.lock'),
      JSON.stringify({ pid: 123456789 }),
    );
    await assert.rejects(acquireLease(root), /SERVICE_ALREADY_RUNNING/);
    await release();
    release = await acquireLease(root);
    await release();
    await release();
    release = undefined;
  } finally {
    await release?.();
    await rm(root, { recursive: true, force: true });
  }
});
