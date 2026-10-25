import {
  mkdir,
  writeFile,
  symlink,
  readFile,
  access,
  lstat,
  rename,
  unlink,
  copyFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './types.js';

/**
 * Effective DSH permission mode for delegated sessions. Explicit configuration
 * wins over the legacy `CODEX_DSH_DSH_SANDBOX` environment variable, which wins
 * over the `workspace-write` default.
 *
 * `auto` is the official Auto review preset: danger-full-access execution plus
 * a per-tool LLM review. It is not a sandbox mode, which is why
 * {@link dshSandboxMode} maps it to danger-full-access for the composition.
 *
 * The Windows ACL backend cannot spawn piped grandchildren (documented
 * limitation), so builds/commands like `node --test` fail under
 * workspace-write there; opt into danger-full-access explicitly for Windows
 * bridges.
 */
export const dshPermissionMode = (config?: Config) => {
  const mode =
    config?.dsh.permissionMode ??
    process.env.CODEX_DSH_DSH_SANDBOX ??
    'workspace-write';
  if (
    !['read-only', 'workspace-write', 'danger-full-access', 'auto'].includes(
      mode,
    )
  )
    throw new Error(
      'DSH permission mode must be read-only, workspace-write, danger-full-access or auto',
    );
  return mode;
};
export const dshSandboxMode = (config?: Config) => {
  const mode = dshPermissionMode(config);
  return mode === 'auto' ? 'danger-full-access' : mode;
};
/** Official per-tool LLM review bundle providing the `auto` permission preset. */
const AUTO_REVIEW_BUNDLE = '@deepseek-ai/dsh-experimental-auto-review';
async function linkExisting(
  source: string,
  target: string,
  kind: 'file' | 'dir' = 'file',
) {
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
    if (process.platform === 'win32') {
      // Windows symlinks need extra privileges: junctions cover directories and
      // small credential files are copied into the isolated home instead.
      if (kind === 'dir') await symlink(source, target, 'junction');
      else await copyFile(source, target);
      return;
    }
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
    'file',
  );
  await safeWrite(
    join(home, 'config.toml'),
    `approval_policy = "never"\nsandbox_mode = "workspace-write"\n[features]\nmulti_agent = false\napps = false\nplugins = false\n[mcp_servers]\n[plugins]\n` +
      // The elevated Windows sandbox is the only mode that can enforce writes
      // on this platform; without it Codex degrades to read-only.
      (process.platform === 'win32' ? `[windows]\nsandbox = "elevated"\n` : ''),
  );
  return home;
}
export async function prepareDsh(config: Config, cwd: string) {
  const mode = dshPermissionMode(config);
  const auto = mode === 'auto';
  // A bundled profile does not mount the configured external modules directory
  // at all, so it must not reuse an isolated home created for one: DSH resolves
  // selected bundles from the running installation first and from the profile
  // directory second, and a reused home would keep the other layout's state.
  const bundled = config.dsh.moduleSource === 'bundled';
  const home = join(
    config.stateDir,
    'dsh-homes',
    createHash('sha256')
      .update(cwd + (bundled ? '\0bundled' : ''))
      .digest('hex')
      .slice(0, 20),
  );
  const profile = join(home, 'profiles/acp');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // `external` keeps the 0.1.x layout: the pre-installed module directory is
  // mounted as the profile's node_modules fallback. `bundled` relies on the
  // launcher's own installation (Desktop carries its complete runtime), which
  // avoids mixing another version's modules with the running runtime.
  if (!bundled)
    await linkExisting(
      config.dsh.modules,
      join(home, 'profiles/node_modules'),
      'dir',
    );
  // Credentials stay in the user's provider store; no Web profile/plugins are inherited.
  await linkExisting(
    join(config.dsh.sourceHome, '.credentials.yaml'),
    join(home, '.credentials.yaml'),
    'file',
  );
  await linkExisting(
    join(config.dsh.sourceHome, 'llm-deepseek'),
    join(home, 'llm-deepseek'),
    'dir',
  );
  const manifest = {
    name: 'bridge-acp-profile',
    private: true,
    type: 'module',
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-acp-app',
          ...(auto ? [AUTO_REVIEW_BUNDLE] : []),
        ],
      },
    },
  };
  await safeWrite(
    join(profile, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  // Only official base + ACP are composed. Disallow runtime plugin installation,
  // permission switching and subagent tools as well as external MCP mounts.
  // Auto mode keeps the permission-preset row: it owns the durable preset/knob
  // write path the Auto helper uses, and the Auto review bundle registers the
  // `auto` preset on it.
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
    ...(auto ? [] : ['permission']),
  ];
  const sandboxMode = dshSandboxMode(config);
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
      config: { mode: sandboxMode, workspaceRoot: cwd },
    },
    {
      id: 'approval',
      config: {
        policy: sandboxMode === 'danger-full-access' ? 'never' : 'ask',
      },
    },
    ...disabled.map((id) => ({ id, disabled: true })),
    ...(auto
      ? [
          {
            insert: [
              {
                id: 'bridge-auto-review',
                // Absolute file URL: the helper stays in this installation and
                // is never copied into, or imported from, the DSH home.
                name: new URL('./dsh-auto-review.js', import.meta.url).href,
              },
            ],
          },
        ]
      : []),
  ];
  // JSON is valid YAML and does not evaluate expressions from configuration text.
  await safeWrite(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify(patch, null, 2) + '\n',
  );
  return home;
}
