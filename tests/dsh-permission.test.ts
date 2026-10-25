import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setup, until } from './helpers.js';
import { apply, READY } from '../src/dsh-auto-review.js';
import {
  AUTO_REVIEW_READY,
  dshPermissionGuard,
} from '../src/dsh-permission.js';
import {
  prepareDsh,
  dshPermissionMode,
  dshSandboxMode,
} from '../src/runtime.js';
import { loadConfig } from '../src/config.js';
import { DshExecutor } from '../src/adapters/dsh.js';
import { Manager } from '../src/manager.js';
import { terminal, type Config } from '../src/types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal stand-in for the DSH permission plugins the helper talks to. */
function fakeDsh(options: { available?: boolean; appendFails?: boolean } = {}) {
  const listeners: ((session: Session) => void)[] = [];
  const existing: Session[] = [];
  interface Session {
    preset: string | null;
    sandbox: string | null;
    approval: 'ask' | 'never' | null;
    appends: string[];
    append(type: 'approval/policy', data: { policy: 'ask' | 'never' }): void;
  }
  const session = (): Session => ({
    preset: null,
    sandbox: null,
    approval: null,
    appends: [],
    append(_type, data) {
      this.appends.push(data.policy);
      if (!options.appendFails) this.approval = data.policy;
    },
  });
  const presets = {
    set(target: Session, name: string) {
      if (options.available === false)
        throw new Error(
          'unknown preset "auto" (known: read-only, workspace-write, danger-full-access)',
        );
      if (name !== 'auto') throw new Error(`Unexpected preset ${name}`);
      target.preset = 'auto';
      target.sandbox = 'danger-full-access';
      target.approval = 'ask';
    },
    current(target: Session) {
      if (
        target.preset === 'auto' &&
        target.sandbox === 'danger-full-access' &&
        (target.approval === 'ask' || target.approval === 'never')
      )
        return 'auto';
      if (
        target.preset === null &&
        target.sandbox === 'danger-full-access' &&
        target.approval === 'never'
      )
        return 'danger-full-access';
      return 'custom';
    },
  };
  const ctx = {
    permissionPresets: presets,
    approval: { overrideOf: (target: Session) => target.approval ?? undefined },
    sessions: { list: () => existing },
    on(event: string, listener: (session: Session) => void) {
      assert.equal(event, 'session/created');
      listeners.push(listener);
    },
  };
  return { ctx, listeners, existing, session };
}

test('Auto initialization selects the official preset, pins final denial, then acknowledges', (t) => {
  // The helper stays dependency-free; this assertion pins the wire string the
  // bridge waits for so the two copies cannot drift apart.
  assert.equal(READY, AUTO_REVIEW_READY);
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });

  const dsh = fakeDsh();
  apply(dsh.ctx);
  const published = dsh.session();
  dsh.listeners[0]!(published);
  assert.equal(published.preset, 'auto');
  assert.equal(published.approval, 'never');
  assert.deepEqual(writes, [READY + '\n']);

  // Republishing the same session (resume) keeps the pinned facts and does not
  // append redundant knob events, but still confirms activation.
  const appends = published.appends.length;
  dsh.listeners[0]!(published);
  assert.equal(published.appends.length, appends);
  assert.equal(writes.length, 2);

  // The official Auto bundle is not loaded: fail closed, never fall back.
  const missing = fakeDsh({ available: false });
  apply(missing.ctx);
  assert.throws(
    () => missing.listeners[0]!(missing.session()),
    /DSH_AUTO_REVIEW_NOT_ACTIVE/,
  );
  assert.equal(writes.length, 2);

  // The pinned denial cannot be read back: fail closed rather than run with
  // an interactive fallback that no answerer can satisfy.
  const unpinned = fakeDsh({ appendFails: true });
  apply(unpinned.ctx);
  assert.throws(
    () => unpinned.listeners[0]!(unpinned.session()),
    /final approval policy is not "never"/,
  );

  // A session published while this plugin was still activating is pinned and
  // acknowledged at activation time.
  const early = fakeDsh();
  const existing = early.session();
  early.existing.push(existing);
  apply(early.ctx);
  assert.equal(existing.preset, 'auto');
  assert.equal(existing.approval, 'never');
  assert.equal(writes.length, 3);
});

test('bundled Auto homes isolate external modules and load the official bundle plus helper', async () => {
  const s = await setup();
  try {
    const base: Config = {
      ...s.config,
      dsh: {
        ...s.config.dsh,
        permissionMode: 'workspace-write',
        moduleSource: 'external',
      },
    };
    const external = await prepareDsh(base, s.cwd);
    const auto: Config = {
      ...base,
      dsh: { ...base.dsh, permissionMode: 'auto', moduleSource: 'bundled' },
    };
    const home = await prepareDsh(auto, s.cwd);
    assert.notEqual(home, external);
    await assert.rejects(access(join(home, 'profiles/node_modules')));
    // Bundled still inherits the provider login; only the module directory is skipped.
    await access(join(home, '.credentials.yaml'));

    const manifest = JSON.parse(
      await readFile(join(home, 'profiles/acp/package.json'), 'utf8'),
    );
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-acp-app',
      '@deepseek-ai/dsh-experimental-auto-review',
    ]);
    const patch = JSON.parse(
      await readFile(join(home, 'profiles/acp/cordis.patch.yml'), 'utf8'),
    );
    const rows = patch.flatMap(
      (row: { insert?: unknown[] }) => row.insert ?? [row],
    );
    assert.ok(
      rows.some((row: any) => row.id === 'tool-subagent' && row.disabled),
    );
    assert.ok(
      !rows.some((row: any) => row.id === 'permission' && row.disabled),
    );
    const helper = rows.find((row: any) => row.id === 'bridge-auto-review');
    assert.match(helper.name, /^file:\/\/\/.*dsh-auto-review\.js$/);

    // The default composition is unchanged: no Auto bundle, no helper, no
    // permission-preset row, because nothing consumes the preset write path.
    const plainPatch = JSON.parse(
      await readFile(join(external, 'profiles/acp/cordis.patch.yml'), 'utf8'),
    );
    const plainRows = plainPatch.flatMap(
      (row: { insert?: unknown[] }) => row.insert ?? [row],
    );
    assert.ok(
      plainRows.some((row: any) => row.id === 'permission' && row.disabled),
    );
    assert.ok(!plainRows.some((row: any) => row.id === 'bridge-auto-review'));
    const plainManifest = JSON.parse(
      await readFile(join(external, 'profiles/acp/package.json'), 'utf8'),
    );
    assert.ok(
      !plainManifest.dsh.profile.bundles.includes(
        '@deepseek-ai/dsh-experimental-auto-review',
      ),
    );
  } finally {
    await s.close();
  }
});

test('explicit permissionMode wins over the legacy sandbox environment variable', () => {
  const config = (permissionMode?: Config['dsh']['permissionMode']) =>
    ({ dsh: permissionMode === undefined ? {} : { permissionMode } }) as Config;
  const previous = process.env.CODEX_DSH_DSH_SANDBOX;
  try {
    process.env.CODEX_DSH_DSH_SANDBOX = 'danger-full-access';
    assert.equal(dshPermissionMode(config('auto')), 'auto');
    assert.equal(dshSandboxMode(config('auto')), 'danger-full-access');
    assert.equal(dshPermissionMode(config('read-only')), 'read-only');
    assert.equal(dshPermissionMode(config()), 'danger-full-access');

    delete process.env.CODEX_DSH_DSH_SANDBOX;
    assert.equal(dshPermissionMode(config()), 'workspace-write');

    // The legacy variable keeps its old meaning and also selects Auto.
    process.env.CODEX_DSH_DSH_SANDBOX = 'auto';
    assert.equal(dshPermissionMode(config()), 'auto');
    assert.equal(dshSandboxMode(config()), 'danger-full-access');

    process.env.CODEX_DSH_DSH_SANDBOX = 'bypass';
    assert.throws(
      () => dshPermissionMode(config()),
      /permission mode must be read-only, workspace-write, danger-full-access or auto/,
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_DSH_DSH_SANDBOX;
    else process.env.CODEX_DSH_DSH_SANDBOX = previous;
  }
});

test('Auto guard releases only after the runtime acknowledgement and fails closed without it', async () => {
  const auto = { dsh: { permissionMode: 'auto' } } as Config;
  const acknowledged = dshPermissionGuard(auto, 1000);
  const verification = acknowledged.verify();
  await sleep(10);
  acknowledged.stderr(`  ${AUTO_REVIEW_READY}  \n`);
  assert.equal(acknowledged.acknowledged, true);
  await verification;

  const silent = dshPermissionGuard(auto, 30);
  await assert.rejects(silent.verify(), /DSH_AUTO_REVIEW_NOT_ACTIVE/);
  assert.equal(silent.acknowledged, false);

  // Outside Auto no acknowledgement is expected; the other modes have no helper.
  const plain = dshPermissionGuard({ dsh: {} } as Config, 30);
  await assert.doesNotReject(plain.verify());
});

test('configuration round-trips the new dsh fields and validates their vocabulary', async () => {
  const s = await setup();
  const path = join(s.root, 'config.json');
  const write = async (dsh: Record<string, unknown>) => {
    await writeFile(
      path,
      JSON.stringify({ ...s.config, dsh: { ...s.config.dsh, ...dsh } }),
    );
    await chmod(path, 0o600);
  };
  try {
    await write({
      permissionMode: 'auto',
      moduleSource: 'bundled',
      modules: 'not-checked-when-bundled',
    });
    const bundled = await loadConfig(path);
    assert.equal(bundled.dsh.permissionMode, 'auto');
    assert.equal(bundled.dsh.moduleSource, 'bundled');

    await write({ permissionMode: 'bypass', moduleSource: 'bundled' });
    await assert.rejects(loadConfig(path));

    await write({
      permissionMode: 'workspace-write',
      moduleSource: 'external',
      modules: 'relative/node_modules',
    });
    await assert.rejects(loadConfig(path), /absolute/);

    await write({
      permissionMode: 'auto',
      moduleSource: 'external',
      modules: resolve('node_modules'),
    });
    const external = await loadConfig(path);
    assert.equal(external.dsh.permissionMode, 'auto');
    assert.equal(external.dsh.moduleSource, 'external');
  } finally {
    await s.close();
  }
});

test('configured Auto fails before sending a prompt if the runtime does not confirm activation', async () => {
  const s = await setup();
  s.config.dsh.permissionMode = 'auto';
  const m = new Manager(
    s.store,
    [s.cwd],
    {
      codex: new DshExecutor(s.config, s.redact),
      dsh: new DshExecutor(s.config, s.redact),
    },
    s.redact,
  );
  try {
    const task = await m.run(
      'codex',
      'do not run without review',
      s.cwd,
      'auto-missing',
    );
    await until(() => terminal(m.owned('codex', task.id).state), 15000);
    assert.match(
      m.owned('codex', task.id).rounds[0]!.error!,
      /DSH_AUTO_REVIEW_NOT_ACTIVE/,
    );
    await assert.rejects(access(join(s.cwd, 'result.txt')));
  } finally {
    await m.close();
    await s.close();
  }
});
