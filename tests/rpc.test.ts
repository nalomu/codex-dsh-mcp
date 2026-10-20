import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Rpc, type ManagedProcess } from '../src/process.js';

test('JSON-RPC preserves UTF-8 text split across byte boundaries', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
  });
  const rpc = new Rpc({
    child,
    stop: async () => {},
  } as unknown as ManagedProcess);
  const pending = rpc.request('fixture', {}, 1000);
  const response = Buffer.from(
    JSON.stringify({ id: 1, result: { text: '桥接完成 🎉' } }) + '\n',
  );
  for (const byte of response) child.stdout.write(Buffer.from([byte]));
  assert.deepEqual(await pending, { text: '桥接完成 🎉' });
  rpc.fail(new Error('closed'));
  child.stdout.end();
});

test('stderr redacts credentials split between chunks before emitting', async () => {
  const { lineSink, redactor } = await import('../src/security.js');
  const lines: string[] = [];
  const sink = lineSink(redactor(['fixture-private-value']), (text) =>
    lines.push(text),
  );
  sink.write('diagnostic fixture-pri');
  assert.equal(lines.length, 0);
  sink.write('vate-value\n');
  sink.end();
  assert.deepEqual(lines, ['diagnostic [REDACTED]\n']);
  const bounded = lineSink(String, (text) => lines.push(text), 10);
  bounded.write('a'.repeat(11));
  bounded.write('secret\n');
  assert.equal(lines.at(-1), '[stderr line exceeded limit]');
});

test('local deadline rejects an uncooperative protocol operation', async () => {
  const { withDeadline } = await import('../src/deadline.js');
  await assert.rejects(
    withDeadline(new Promise(() => {}), 15, 'TEST_TIMEOUT'),
    /TEST_TIMEOUT/,
  );
});
