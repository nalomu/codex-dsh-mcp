import { readFile, mkdir, writeFile, access, stat } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod/v4';
import type { Config } from './types.js';
const runtime = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
const schema = z.object({
  port: z.number().int().min(1024).max(65535).default(43219),
  allowedRoots: z.array(z.string()).min(1),
  stateDir: z.string(),
  tokens: z.object({ codex: z.string().min(32), dsh: z.string().min(32) }),
  codex: runtime.extend({
    model: z.string().optional(),
    sourceHome: z.string(),
  }),
  dsh: runtime.extend({
    provider: z.string().min(1),
    model: z.string().min(1),
    sourceHome: z.string(),
    modules: z.string(),
    moduleSource: z.enum(['external', 'bundled']).optional(),
    permissionMode: z
      .enum(['read-only', 'workspace-write', 'danger-full-access', 'auto'])
      .optional(),
  }),
  taskTimeoutMs: z.number().int().min(1000).max(86400000).default(1800000),
});
export const defaultConfig = () =>
  resolve(
    process.env.BRIDGE_CONFIG ?? join(process.cwd(), '.bridge/config.json'),
  );
export async function loadConfig(path = defaultConfig()): Promise<Config> {
  const mode = (await stat(path)).mode;
  // Windows does not expose POSIX permission bits; ACLs own this boundary there.
  if (process.platform !== 'win32' && mode & 0o077)
    throw new Error('Config contains credentials: chmod 600 ' + path);
  const config = schema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (config.tokens.codex === config.tokens.dsh)
    throw new Error('Caller tokens must be distinct');
  for (const p of [
    config.stateDir,
    config.codex.sourceHome,
    config.dsh.sourceHome,
    ...(config.dsh.moduleSource === 'bundled' ? [] : [config.dsh.modules]),
    ...config.allowedRoots,
  ])
    if (!isAbsolute(p)) throw new Error('Configuration paths must be absolute');
  return config;
}
export async function initConfig(path: string, roots: string[]) {
  if (!roots.length)
    throw new Error('Usage: init --root /absolute/project [--root /other]');
  const home = homedir();
  const stateDir = resolve(path, '..');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let command = 'dsh';
  let args: string[] = [];
  let modules = join(home, '.dsh/profiles/node_modules');
  const cli = join(
    home,
    '.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js',
  );
  try {
    await access(cli);
    command = process.execPath;
    args = [cli];
  } catch {
    // Portable installs (notably Windows) point at an explicit Node + dsh entry.
    const node = process.env.CODEX_DSH_DSH_NODE;
    const bin = process.env.CODEX_DSH_DSH_BIN;
    if (node && bin) {
      command = node;
      args = [bin];
      modules =
        process.env.CODEX_DSH_DSH_MODULES ?? resolve(dirname(bin), '../../..');
    }
  }
  const config: Config = {
    port: 43219,
    allowedRoots: roots.map((p) => resolve(p)),
    stateDir,
    tokens: {
      codex: randomBytes(32).toString('hex'),
      dsh: randomBytes(32).toString('hex'),
    },
    codex: {
      command: process.env.CODEX_DSH_CODEX_BIN ?? 'codex',
      args: [],
      env: {},
      sourceHome: join(home, '.codex'),
    },
    dsh: {
      command,
      args,
      env: {},
      sourceHome: join(home, '.dsh'),
      modules,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    },
    taskTimeoutMs: 1800000,
  };
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return config;
}
