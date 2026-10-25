import { request } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { setup, until } from './helpers.js';
import { Manager } from '../src/manager.js';
import { CodexExecutor } from '../src/adapters/codex.js';
import { DshExecutor } from '../src/adapters/dsh.js';
import { serve } from '../src/server.js';
import { terminal, type Caller } from '../src/types.js';
import { exec } from '../src/security.js';
async function connected(caller: Caller, config: any) {
  const client = new Client({ name: 'bridge-test', version: '1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${config.port}/mcp/${caller}`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${config.tokens[caller]}` },
        },
      },
    ),
  );
  return client;
}
async function call(client: Client, name: string, args: any) {
  const r = await client.callTool({
    name,
    arguments: ['agent_status', 'agent_wait'].includes(name)
      ? { detail: 'full', ...args }
      : args,
  });
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return r.structuredContent as any;
}
test('MCP HTTP → both real protocol adapters: edit, disconnect, reconnect, continuation, isolation and authentication', async () => {
  const s = await setup();
  const manager = new Manager(
    s.store,
    s.config.allowedRoots,
    {
      codex: new CodexExecutor(s.config, s.redact),
      dsh: new DshExecutor(s.config, s.redact),
    },
    s.redact,
  );
  const app = await serve(s.config, manager);
  const clients: Client[] = [];
  try {
    await exec('git', ['init', '-q', s.cwd]);
    await writeFile(join(s.cwd, 'dirty.txt'), 'keep me');
    const base = `http://127.0.0.1:${s.config.port}`;
    assert.equal(
      (await fetch(base + '/mcp/codex', { method: 'POST' })).status,
      401,
    );
    assert.equal(
      (await fetch(base + '/admin/stop', { method: 'POST' })).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + '/mcp/dsh', {
          method: 'POST',
          headers: { Authorization: `Bearer ${s.config.tokens.codex}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + '/health', {
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    assert.equal(
      await new Promise((resolve) => {
        const r = request(
          base + '/health',
          { headers: { Host: 'evil.example' } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        r.end();
      }),
      403,
    );
    for (const caller of ['codex', 'dsh'] as const) {
      let client = await connected(caller, s.config);
      clients.push(client);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 7);
      const { task } = await call(client, 'agent_run', {
        prompt: 'slow',
        cwd: s.cwd,
        idempotencyKey: caller + '-first',
      });
      await client.close();
      await until(() => terminal(manager.owned(caller, task.id).state), 10000);
      client = await connected(caller, s.config);
      clients.push(client);
      let status = await call(client, 'agent_status', { taskId: task.id });
      assert.equal(status.task.state, 'succeeded', JSON.stringify(status.task));
      const session = status.task.sessionId;
      await call(client, 'agent_continue', {
        taskId: task.id,
        prompt: 'next',
        idempotencyKey: 'next',
      });
      await until(() => terminal(manager.owned(caller, task.id).state), 10000);
      status = await call(client, 'agent_status', { taskId: task.id });
      assert.equal(status.task.state, 'succeeded', JSON.stringify(status.task));
      assert.equal(status.task.sessionId, session);
      assert.equal(status.task.rounds.length, 2);
      assert.match(status.task.rounds[1].result, /round 2/);
      assert.equal(await readFile(join(s.cwd, 'dirty.txt'), 'utf8'), 'keep me');
      await call(client, 'agent_continue', {
        taskId: task.id,
        prompt: 'observe',
        idempotencyKey: 'observe',
      });
      await until(() => terminal(manager.owned(caller, task.id).state), 10000);
      const observed = await call(client, 'agent_status', {
        taskId: task.id,
        limit: 200,
      });
      const progress = JSON.stringify(observed.events);
      assert.ok(progress.includes('node --test'));
      assert.ok(progress.includes('4 passed'));
      assert.ok(!progress.includes('fixture-progress-private-key'));
      const opposite = await connected(
        caller === 'codex' ? 'dsh' : 'codex',
        s.config,
      );
      clients.push(opposite);
      await assert.rejects(
        call(opposite, 'agent_status', { taskId: task.id }),
        /TASK_NOT_FOUND/,
      );
    }
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await app.close();
    await s.close();
  }
});
test('permission denial and inherited MCP fail closed; cancellation kills descendants before unlocking', async () => {
  const s = await setup();
  const m = new Manager(
    s.store,
    s.config.allowedRoots,
    {
      codex: new CodexExecutor(s.config, s.redact),
      dsh: new DshExecutor(s.config, s.redact),
    },
    s.redact,
  );
  try {
    for (const caller of ['codex', 'dsh'] as const) {
      const t = await m.run(caller, 'permission', s.cwd, 'perm-' + caller);
      await until(() => terminal(m.owned(caller, t.id).state), 10000);
      assert.equal(
        m.owned(caller, t.id).state,
        'failed',
        JSON.stringify(m.owned(caller, t.id)),
      );
      assert.ok(
        m
          .status(caller, t.id)
          .events.some((e) => e.kind === 'permission_denied'),
        JSON.stringify(m.status(caller, t.id)),
      );
    }
    s.config.codex.env.INHERITED_MCP = '1';
    const bad = await m.run('dsh', 'work', s.cwd, 'mcp');
    await until(() => terminal(m.owned('dsh', bad.id).state), 10000);
    assert.match(
      m.owned('dsh', bad.id).rounds[0]!.error!,
      /NESTED_DELEGATION_DENIED/,
    );
    delete s.config.codex.env.INHERITED_MCP;
    const hang = await m.run('codex', 'hang', s.cwd, 'hang');
    await until(() =>
      m.status('codex', hang.id).events.some((e) => e.kind === 'session'),
    );
    await new Promise((r) => setTimeout(r, 200));
    await m.cancel('codex', hang.id);
    assert.equal(m.owned('codex', hang.id).state, 'cancelled');
    await new Promise((r) => setTimeout(r, 3100));
    await assert.rejects(access(join(s.cwd, 'escaped.txt')));
  } finally {
    await m.close();
    await s.close();
  }
});

test('daemon SIGKILL stops orphan workers; restart persists interruption without replay', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const s = await setup();
  const path = join(s.config.stateDir, 'config.json');
  await writeFile(path, JSON.stringify(s.config), { mode: 0o600 });
  let daemon: ReturnType<typeof spawn> | undefined;
  let client: Client | undefined;
  const start = async () => {
    daemon = spawn(
      process.execPath,
      ['dist/cli.js', 'serve', '--config', path],
      { stdio: 'ignore' },
    );
    await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${s.config.port}/health`)).ok;
      } catch {
        return false;
      }
    }, 10000);
  };
  try {
    await start();
    client = await connected('codex', s.config);
    const { task } = await call(client, 'agent_run', {
      prompt: 'hang',
      cwd: s.cwd,
      idempotencyKey: 'crash',
    });
    await until(async () => {
      const st = await call(client!, 'agent_status', { taskId: task.id });
      return st.events.some((e: any) => e.kind === 'session');
    }, 10000);
    await new Promise((r) => setTimeout(r, 200));
    const dead = once(daemon!, 'exit');
    daemon!.kill('SIGKILL');
    await dead;
    await client.close();
    client = undefined;
    await start();
    client = await connected('codex', s.config);
    const st = await call(client, 'agent_status', { taskId: task.id });
    assert.equal(st.task.state, 'interrupted');
    await new Promise((r) => setTimeout(r, 3100));
    await assert.rejects(access(join(s.cwd, 'escaped.txt')));
    const again = await call(client, 'agent_run', {
      prompt: 'hang',
      cwd: s.cwd,
      idempotencyKey: 'crash',
    });
    assert.equal(again.task.id, task.id);
    assert.equal(again.task.state, 'interrupted');
  } finally {
    await client?.close().catch(() => {});
    if (daemon?.exitCode === null && daemon?.signalCode === null) {
      const done = once(daemon, 'exit');
      daemon.kill('SIGTERM');
      await done;
    }
    await s.close();
  }
});
