import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Manager } from '../src/manager.js';
import { redactor } from '../src/security.js';
import type { Config, Executor, Caller } from '../src/types.js';
export async function setup(executors?: Record<Caller, Executor>) {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-test-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const stateDir = join(root, 'state');
  await mkdir(stateDir);
  await mkdir(join(root, 'unused'));
  await writeFile(join(root, 'unused/.credentials.yaml'), '{}');
  const config: Config = {
    port: 45000 + Math.floor(Math.random() * 15000),
    allowedRoots: [cwd],
    stateDir,
    tokens: {
      codex: randomBytes(32).toString('hex'),
      dsh: randomBytes(32).toString('hex'),
    },
    codex: {
      command: process.execPath,
      args: [resolve('tests/peer.mjs'), 'codex'],
      env: {},
      sourceHome: join(root, 'unused'),
    },
    dsh: {
      command: process.execPath,
      args: [resolve('tests/peer.mjs'), 'dsh'],
      env: {},
      provider: 'test',
      model: 'test',
      sourceHome: join(root, 'unused'),
      modules: resolve('node_modules'),
    },
    taskTimeoutMs: 10000,
  };
  const store = new Store(join(stateDir, 'tasks.sqlite'));
  const redact = redactor(Object.values(config.tokens));
  const manager = executors
    ? new Manager(store, [cwd], executors, redact, config.taskTimeoutMs)
    : undefined;
  return {
    root,
    cwd,
    config,
    store,
    redact,
    manager,
    async close() {
      await manager?.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function until(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error('condition timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}
