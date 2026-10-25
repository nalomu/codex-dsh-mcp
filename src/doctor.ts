import { access, readFile } from 'node:fs/promises';
import { Writable, Readable } from 'node:stream';
import { join } from 'node:path';
import {
  ClientApp,
  ndJsonStream,
  PROTOCOL_VERSION,
  type NewSessionResponse,
} from '@agentclientprotocol/sdk';
import { exec, childEnv } from './security.js';
import {
  prepareCodex,
  prepareDsh,
  dshPermissionMode,
  dshSandboxMode,
} from './runtime.js';
import { ManagedProcess } from './process.js';
import { dshPermissionGuard } from './dsh-permission.js';
import type { Config } from './types.js';
export async function doctor(config: Config, redact: (v: unknown) => string) {
  const permissionMode = dshPermissionMode(config);
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: redact(await fn()) });
    } catch (e) {
      checks.push({ name, ok: false, detail: redact(String(e)) });
    }
  };
  await check('allowedRoots', async () => {
    for (const p of config.allowedRoots) await access(p);
    return `${config.allowedRoots.length} configured directories`;
  });
  await check('codex-login', async () => {
    const home = await prepareCodex(config);
    const r = await exec(
      config.codex.command,
      [...config.codex.args, 'login', 'status'],
      {
        env: childEnv({ ...config.codex.env, CODEX_HOME: home }),
        timeout: 10000,
      },
    );
    return r.stdout + r.stderr;
  });
  await check('codex-protocol-version', async () => {
    const generated = JSON.parse(
      await readFile(
        new URL('./generated/codex-version.json', import.meta.url),
        'utf8',
      ),
    );
    const r = await exec(
      config.codex.command,
      [...config.codex.args, '--version'],
      { timeout: 10000 },
    );
    if (r.stdout.trim() !== generated.version)
      throw new Error(
        `Regenerate Codex types: expected ${generated.version}, installed ${r.stdout.trim()}`,
      );
    return generated.version;
  });
  await check('dsh-credentials', async () => {
    await access(join(config.dsh.sourceHome, '.credentials.yaml'));
    return 'Provider credential store exists; model access requires a real inference test';
  });
  await check('dsh-acp-model', async () => {
    const cwd = config.allowedRoots[0]!;
    const home = await prepareDsh(config, cwd);
    const permission = dshPermissionGuard(config);
    const diagnostics: string[] = [];
    const proc = new ManagedProcess(
      { ...config.dsh, args: [...config.dsh.args, '--profile', 'acp'] },
      cwd,
      { DSH_HOME: home, DSH_PERMISSION_MODE: dshSandboxMode(config) },
      redact,
      (s) => {
        permission.stderr(s);
        diagnostics.push(s);
        if (diagnostics.length > 8) diagnostics.shift();
      },
    );
    const app = new ClientApp();
    app.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'cancelled' },
    }));
    app.onNotification('session/update', () => {});
    const cx = app.connect(
      ndJsonStream(
        Writable.toWeb(proc.child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    const timeout = setTimeout(() => {
      cx.close(new Error('ACP_PREFLIGHT_TIMEOUT'));
      void proc.stop().catch(() => {});
    }, 30000);
    try {
      const init = await cx.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'bridge-doctor', version: '0.1.0' },
      });
      if (init.protocolVersion !== 1) throw new Error('ACP v1 required');
      const session = await cx.agent.request<NewSessionResponse>(
        'session/new',
        { cwd, mcpServers: [] },
      );
      if (
        session.configOptions?.find((o) => o.id === 'model')?.currentValue !==
        JSON.stringify([config.dsh.provider, config.dsh.model])
      )
        throw new Error('DSH_MODEL_CONFIGURATION_MISMATCH');
      await cx.agent.request('session/close', { sessionId: session.sessionId });
      // In Auto mode the helper plugin acknowledges session initialization over
      // stderr; without it the session could accept unreviewed work, so this
      // preflight fails rather than reporting a usable runtime.
      await permission.verify();
      return `ACP v1 session creation/close OK; configured ${config.dsh.provider}/${config.dsh.model}; permissions ${permissionMode}${permissionMode === 'auto' ? ' (Auto review activation confirmed)' : ''}; inference not checked`;
    } catch (e) {
      throw new Error(
        `${String(e)}${diagnostics.length ? '\n' + diagnostics.join('') : ''}`,
      );
    } finally {
      clearTimeout(timeout);
      cx.close();
      await proc.stop();
    }
  });
  return { ok: checks.every((c) => c.ok), checks };
}
