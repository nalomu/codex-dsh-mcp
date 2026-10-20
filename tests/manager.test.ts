import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, until } from './helpers.js';
import { Store } from '../src/store.js';
import { Manager } from '../src/manager.js';
import { exec, redactor, childEnv } from '../src/security.js';
import { terminal, type Executor } from '../src/types.js';
function controlled() {
  let active = 0,
    max = 0;
  const starts: string[] = [];
  const finish = new Map<string, () => void>();
  const executor: Executor = {
    async run(i) {
      active++;
      max = Math.max(max, active);
      starts.push(i.prompt);
      i.session(i.sessionId ?? 'session-' + i.prompt);
      i.emit('message', 'progress');
      try {
        await new Promise<void>((resolve) => {
          finish.set(i.prompt, resolve);
          i.signal.addEventListener('abort', () => setTimeout(resolve, 50), {
            once: true,
          });
        });
        if (i.signal.aborted) throw i.signal.reason;
        return 'done ' + i.prompt;
      } finally {
        active--;
      }
    },
  };
  return {
    executor,
    starts,
    finish,
    get active() {
      return active;
    },
    get max() {
      return max;
    },
  };
}
test('both directions queue the same Git root; aliases and nested paths share a lock; cancel waits for stop', async () => {
  const c = controlled();
  const s = await setup({ codex: c.executor, dsh: c.executor });
  const m = s.manager!;
  try {
    await exec('git', ['init', '-q', s.cwd]);
    await mkdir(join(s.cwd, 'nested'));
    await symlink(s.cwd, join(s.cwd, 'alias'));
    const a = await m.run('codex', 'one', s.cwd, '1');
    const retry = await m.run('codex', 'one', s.cwd, '1');
    assert.equal(a.id, retry.id);
    await assert.rejects(
      m.run('codex', 'changed', s.cwd, '1'),
      /IDEMPOTENCY_CONFLICT/,
    );
    const b = await m.run('dsh', 'two', join(s.cwd, 'alias/nested'), '2');
    await until(() => c.starts.length === 1);
    assert.equal(m.owned('dsh', b.id).state, 'queued');
    assert.throws(() => m.owned('dsh', a.id), /TASK_NOT_FOUND/);
    const start = Date.now();
    await m.cancel('codex', a.id);
    assert.ok(Date.now() - start >= 45);
    await until(() => c.starts.length === 2);
    assert.equal(c.max, 1);
    c.finish.get('two')!();
    await until(() => terminal(m.owned('dsh', b.id).state));
    assert.equal(m.owned('dsh', b.id).target, 'codex');
    assert.equal(m.owned('codex', a.id).target, 'dsh');
  } finally {
    await s.close();
  }
});
test('continuation keeps session and has idempotency, ownership and busy checks', async () => {
  const c = controlled();
  const s = await setup({ codex: c.executor, dsh: c.executor });
  const m = s.manager!;
  try {
    const a = await m.run('codex', 'one', s.cwd, '1');
    await until(() => c.starts.length === 1);
    await assert.rejects(m.continue('codex', a.id, 'bad', 'busy'), /TASK_BUSY/);
    c.finish.get('one')!();
    await until(() => m.owned('codex', a.id).state === 'succeeded');
    const sid = m.owned('codex', a.id).sessionId;
    const b = await m.continue('codex', a.id, 'two', 'c1');
    await m.continue('codex', a.id, 'two', 'c1');
    assert.equal(m.owned('codex', b.id).rounds.length, 2);
    await assert.rejects(
      m.continue('codex', a.id, 'other', 'c1'),
      /IDEMPOTENCY_CONFLICT/,
    );
    await until(() => c.starts.length === 2);
    c.finish.get('two')!();
    await until(() => m.owned('codex', a.id).state === 'succeeded');
    assert.equal(m.owned('codex', a.id).sessionId, sid);
  } finally {
    await s.close();
  }
});
test('invalid directory and escaping symlink denied; queue cancellation does not start executor', async () => {
  const c = controlled();
  const s = await setup({ codex: c.executor, dsh: c.executor });
  const m = s.manager!;
  try {
    await symlink(s.root, join(s.cwd, 'escape'));
    await assert.rejects(
      m.run('codex', 'x', join(s.cwd, 'escape'), 'escape'),
      /WORKSPACE_DENIED/,
    );
    await assert.rejects(
      m.run('codex', 'x', '.', 'relative'),
      /WORKSPACE_DENIED/,
    );
    const a = await m.run('codex', 'one', s.cwd, '1');
    const b = await m.run('dsh', 'two', s.cwd, '2');
    await until(() => c.starts.length === 1);
    await m.cancel('dsh', b.id);
    await m.cancel('codex', a.id);
    assert.deepEqual(c.starts, ['one']);
    assert.equal(m.owned('dsh', b.id).state, 'cancelled');
  } finally {
    await s.close();
  }
});
test('event cursors, persistence and restart interruption do not replay work', async () => {
  const c = controlled();
  const s = await setup({ codex: c.executor, dsh: c.executor });
  const m = s.manager!;
  try {
    const a = await m.run('codex', 'one', s.cwd, '1');
    await until(() => c.starts.length === 1);
    const first = m.status('codex', a.id, 0, 1);
    assert.equal(first.events.length, 1);
    const next = m.status('codex', a.id, first.nextCursor);
    assert.ok(next.events.every((e) => e.seq > first.nextCursor));
    await m.cancel('codex', a.id);
    const t = m.owned('codex', a.id);
    t.state = 'running';
    t.rounds.at(-1)!.state = 'running';
    s.store.save(t);
    const other = new Store(join(s.config.stateDir, 'tasks.sqlite'));
    const recovered = new Manager(
      other,
      [s.cwd],
      { codex: c.executor, dsh: c.executor },
      String,
    );
    recovered.recover();
    assert.equal(recovered.owned('codex', a.id).state, 'interrupted');
    assert.equal(c.starts.length, 1);
    other.close();
  } finally {
    await s.close();
  }
});
test('wait wakes on progress, times out within bound and returns terminal immediately', async () => {
  const c = controlled();
  const s = await setup({ codex: c.executor, dsh: c.executor });
  const m = s.manager!;
  try {
    const a = await m.run('codex', 'one', s.cwd, '1');
    await until(() => c.starts.length === 1);
    const cursor = m.status('codex', a.id).nextCursor;
    const start = Date.now();
    await m.wait('codex', a.id, cursor, 30);
    assert.ok(Date.now() - start >= 25);
    const pending = m.wait('codex', a.id, cursor, 1000);
    c.finish.get('one')!();
    assert.equal((await pending).task.state, 'succeeded');
  } finally {
    await s.close();
  }
});
test('Git baseline preserves dirty files and records before/after without attribution', async () => {
  const worker: Executor = {
    async run(i) {
      i.session('s');
      await writeFile(join(i.cwd, 'new.txt'), 'worker');
      return 'done';
    },
  };
  const s = await setup({ codex: worker, dsh: worker });
  const m = s.manager!;
  try {
    await exec('git', ['init', '-q', s.cwd]);
    await writeFile(join(s.cwd, 'existing.txt'), 'my edit');
    const t = await m.run('codex', 'work', s.cwd, '1');
    await until(() => terminal(m.owned('codex', t.id).state));
    assert.equal(
      await readFile(join(s.cwd, 'existing.txt'), 'utf8'),
      'my edit',
    );
    const r = m.owned('codex', t.id).rounds[0]!;
    assert.match(r.before!.status!, /existing.txt/);
    assert.match(r.after!.status!, /new.txt/);
    assert.match(r.after!.warning, /not attributable/);
  } finally {
    await s.close();
  }
});
test('redaction removes credentials; child environment excludes inherited bridge tokens', () => {
  const redact = redactor(['a-secret-token-value']);
  assert.equal(
    redact('Bearer abcd a-secret-token-value sk-123abcd'),
    'Bearer [REDACTED] [REDACTED] [REDACTED]',
  );
  process.env.BRIDGE_SECRET_TEST = 'must-not-pass';
  assert.equal(childEnv({}).BRIDGE_SECRET_TEST, undefined);
  assert.throws(() => childEnv({ BRIDGE_TOKEN: 'no' }), /bridge credentials/);
  delete process.env.BRIDGE_SECRET_TEST;
});

test('quarantine recovery requires verified process exit and allows explicit continuation', async () => {
  const c = controlled();
  const s = await setup({ codex: c.executor, dsh: c.executor });
  const m = s.manager!;
  try {
    const task = await m.run('codex', 'initial', s.cwd, 'recovery');
    await until(() => c.starts.length === 1);
    c.finish.get('initial')!();
    await until(() => m.owned('codex', task.id).state === 'succeeded');
    const quarantined = m.owned('codex', task.id);
    quarantined.state = 'interrupted';
    quarantined.workerPid = 123456789;
    quarantined.rounds.at(-1)!.state = 'interrupted';
    s.store.save(quarantined);
    assert.throws(() => m.recover(), /verified process-group exit/);
    assert.throws(() => m.recover(() => false), /verified process-group exit/);
    m.recover((pid) => pid === 123456789);
    assert.equal(m.owned('codex', task.id).workerPid, undefined);
    await m.continue('codex', task.id, 'resume', 'explicit');
    await until(() => c.starts.length === 2);
    c.finish.get('resume')!();
    await until(() => m.owned('codex', task.id).state === 'succeeded');
  } finally {
    await s.close();
  }
});
