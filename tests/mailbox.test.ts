import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setup, until } from './helpers.js';
import { Manager } from '../src/manager.js';
import { Store } from '../src/store.js';
import { ReportDecoder } from '../src/coordination.js';
import { terminal, type Executor } from '../src/types.js';
const report = (kind: string, text: string) =>
  '```bridge-message\n' + JSON.stringify({ kind, text }) + '\n```';
function manager(s: Awaited<ReturnType<typeof setup>>, executor: Executor) {
  return new Manager(
    s.store,
    [s.cwd],
    { codex: executor, dsh: executor },
    s.redact,
    15000,
  );
}
test('reports decode across chunks, ignore ordinary logs, deduplicate and bound progress', () => {
  const reports: unknown[] = [];
  const d = new ReportDecoder((r) => reports.push(r));
  const message = report('progress', 'ready');
  for (const char of 'ordinary output\n' + message + message) d.write(char);
  d.write(report('question', 'x'.repeat(3000)));
  assert.equal(reports.length, 2);
  assert.equal(d.last!.text.length, 1000);
});
test('questions wait for durable replies, then resume the same session; compact observation excludes logs and prompts', async () => {
  const s = await setup();
  let calls = 0;
  let restored: string | undefined;
  const executor: Executor = {
    async run(i) {
      calls++;
      restored = i.sessionId;
      i.session('worker-session');
      i.emit('tool', { output: 'verbose-private-debug-log'.repeat(3000) });
      if (calls === 1) {
        i.emit('message', report('question', 'Which label should I use?'));
        return report('question', 'Which label should I use?');
      }
      assert.ok(i.prompt.includes('use blue'));
      i.emit('message', report('result', 'Applied the requested label.'));
      return report('result', 'Applied the requested label.');
    },
  };
  const m = manager(s, executor);
  try {
    const t = await m.run(
      'codex',
      'original lengthy task context '.repeat(200),
      s.cwd,
      'question',
    );
    await until(() => m.owned('codex', t.id).state === 'waiting');
    const compact = m.observe('codex', t.id);
    const full = m.status('codex', t.id);
    assert.ok(JSON.stringify(compact).includes('Which label'));
    assert.ok(!JSON.stringify(compact).includes('verbose-private-debug-log'));
    assert.ok(!JSON.stringify(compact).includes('original lengthy'));
    assert.ok(
      JSON.stringify(compact).length < JSON.stringify(full).length / 10,
    );
    await assert.rejects(
      m.send('dsh', t.id, 'wrong owner', 'x'),
      /TASK_NOT_FOUND/,
    );
    const receipt = await m.send('codex', t.id, 'use blue', 'reply');
    await until(() => terminal(m.owned('codex', t.id).state));
    assert.equal(restored, 'worker-session');
    assert.equal(calls, 2);
    assert.equal(s.store.pending(t.id).length, 0);
    const duplicate = await m.send('codex', t.id, 'use blue', 'reply');
    assert.equal(duplicate.messageId, receipt.messageId);
    assert.equal(duplicate.delivery, 'delivered');
    assert.equal(calls, 2);
    await assert.rejects(
      m.send('codex', t.id, 'different', 'reply'),
      /IDEMPOTENCY_CONFLICT/,
    );
    const recovered = new Store(join(s.config.stateDir, 'tasks.sqlite'));
    try {
      assert.equal(recovered.pending(t.id).length, 0);
    } finally {
      recovered.close();
    }
  } finally {
    await m.close();
    await s.close();
  }
});
test('running inbox messages are queued until a safe turn boundary and idle messages start one new round', async () => {
  const s = await setup();
  let release: () => void = () => {};
  let calls = 0;
  const executor: Executor = {
    async run(i) {
      calls++;
      i.session('same');
      if (calls === 1)
        await new Promise<void>((r) => {
          release = r;
          i.signal.addEventListener('abort', r, { once: true });
        });
      if (calls > 1) assert.equal(i.sessionId, 'same');
      return report(
        'result',
        i.prompt.includes('follow instruction') ? 'received' : 'done',
      );
    },
  };
  const m = manager(s, executor);
  try {
    const t = await m.run('codex', 'first', s.cwd, 'running-mail');
    await until(() => calls === 1);
    const sent = await m.send('codex', t.id, 'follow instruction', 'during');
    assert.equal(sent.delivery, 'queued');
    assert.equal(calls, 1);
    assert.equal(s.store.pending(t.id).length, 1);
    release();
    await until(() => terminal(m.owned('codex', t.id).state));
    assert.equal(calls, 2);
    assert.equal(s.store.pending(t.id).length, 0);
    await m.send('codex', t.id, 'follow instruction again', 'idle');
    await until(() => terminal(m.owned('codex', t.id).state) && calls === 3);
    assert.equal(m.owned('codex', t.id).rounds.length, 2);
  } finally {
    await m.close();
    await s.close();
  }
});
test('compact wait does not wake for hidden tool logs; waiting tasks can be cancelled', async () => {
  const s = await setup();
  let execution: any;
  const executor: Executor = {
    async run(i) {
      execution = i;
      await new Promise<void>((r) =>
        i.signal.addEventListener('abort', () => r(), { once: true }),
      );
      return '';
    },
  };
  const m = manager(s, executor);
  try {
    const t = await m.run('codex', 'task', s.cwd, 'compact-wait');
    await until(() => !!execution);
    const after = m.observe('codex', t.id).nextCursor;
    let woke = false;
    const pending = m.wait('codex', t.id, after, 1000, 'compact').then((x) => {
      woke = true;
      return x;
    });
    execution.emit('tool', { output: 'invisible' });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(woke, false);
    execution.emit('message', report('progress', 'checkpoint'));
    const response = await pending;
    assert.ok(response.events.some((e) => e.kind === 'report'));
    await m.cancel('codex', t.id);
    assert.equal(m.owned('codex', t.id).state, 'cancelled');
  } finally {
    await m.close();
    await s.close();
  }
});
test('pending messages survive reopening storage without executing or redelivering themselves', async () => {
  const s = await setup();
  try {
    const first = s.store.enqueue(
      'task',
      'key',
      'fingerprint',
      'queued message',
    );
    const other = new Store(join(s.config.stateDir, 'tasks.sqlite'));
    try {
      assert.equal(other.pending('task')[0]!.id, first.message.id);
      assert.equal(
        other.enqueue('task', 'key', 'fingerprint', 'queued message').created,
        false,
      );
    } finally {
      other.close();
    }
  } finally {
    await s.close();
  }
});
test('a worker waiting for a supervisor reply releases cleanly on cancellation', async () => {
  const s = await setup();
  const m = manager(s, {
    async run() {
      return report('question', 'Please choose an option.');
    },
  });
  try {
    const task = await m.run('codex', 'ask', s.cwd, 'cancel-question');
    await until(() => m.owned('codex', task.id).state === 'waiting');
    const cancelled = await m.cancel('codex', task.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.workerPid, undefined);
  } finally {
    await m.close();
    await s.close();
  }
});
