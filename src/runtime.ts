import {
  mkdir,
  writeFile,
  symlink,
  readFile,
  access,
  lstat,
  rename,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './types.js';
async function linkExisting(source: string, target: string) {
  try {
    await access(source);
  } catch {
    return;
  }
  try {
    await lstat(target);
    return;
  } catch {
    /* create only */
  }
  try {
    await symlink(source, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}
async function safeWrite(path: string, text: string) {
  try {
    if ((await readFile(path, 'utf8')) === text) return;
  } catch {
    /* create */
  }
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function prepareCodex(config: Config) {
  const home = join(config.stateDir, 'codex-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await linkExisting(
    join(config.codex.sourceHome, 'auth.json'),
    join(home, 'auth.json'),
  );
  await safeWrite(
    join(home, 'config.toml'),
    `approval_policy = "never"\nsandbox_mode = "workspace-write"\n[features]\nmulti_agent = false\napps = false\nplugins = false\n[mcp_servers]\n[plugins]\n`,
  );
  return home;
}
export async function prepareDsh(config: Config, cwd: string) {
  const home = join(
    config.stateDir,
    'dsh-homes',
    createHash('sha256').update(cwd).digest('hex').slice(0, 20),
  );
  const profile = join(home, 'profiles/acp');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await linkExisting(config.dsh.modules, join(home, 'profiles/node_modules'));
  // Credentials stay in the user's provider store; no Web profile/plugins are inherited.
  await linkExisting(
    join(config.dsh.sourceHome, '.credentials.yaml'),
    join(home, '.credentials.yaml'),
  );
  await linkExisting(
    join(config.dsh.sourceHome, 'llm-deepseek'),
    join(home, 'llm-deepseek'),
  );
  const manifest = {
    name: 'bridge-acp-profile',
    private: true,
    type: 'module',
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
      },
    },
  };
  await safeWrite(
    join(profile, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  // Only official base + ACP are composed. Disallow runtime plugin installation,
  // permission switching and subagent tools as well as external MCP mounts.
  const disabled = [
    'plugin-manager',
    'tool-plugin-manager',
    'hmr',
    'tool-subagent',
    'tool-subagent-fork',
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-ralph',
    'tool-workflow',
    'permission',
  ];
  const patch = [
    {
      id: 'acp',
      config: { provider: config.dsh.provider, model: config.dsh.model },
    },
    {
      id: 'agent-default-model',
      config: { provider: config.dsh.provider, model: config.dsh.model },
    },
    {
      id: 'sandbox-policy',
      config: { mode: 'workspace-write', workspaceRoot: cwd },
    },
    { id: 'approval', config: { policy: 'ask' } },
    ...disabled.map((id) => ({ id, disabled: true })),
  ];
  // JSON is valid YAML and does not evaluate expressions from configuration text.
  await safeWrite(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify(patch, null, 2) + '\n',
  );
  return home;
}
