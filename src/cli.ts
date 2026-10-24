#!/usr/bin/env node
import {
  mkdir,
  readFile,
  writeFile,
  open,
  unlink,
  chmod,
} from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { loadConfig, defaultConfig, initConfig } from './config.js';
import { redactor, exec } from './security.js';
import { Store } from './store.js';
import { Manager } from './manager.js';
import { CodexExecutor } from './adapters/codex.js';
import { DshExecutor } from './adapters/dsh.js';
import { serve } from './server.js';
import { doctor } from './doctor.js';
import { delay, groupAlive } from './process.js';
import type { Config } from './types.js';
import { acquireLease } from './lease.js';
const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const configPath = resolve(value('--config') ?? defaultConfig());
async function health(config: Config) {
  const res = await fetch(`http://127.0.0.1:${config.port}/health`, {
    signal: AbortSignal.timeout(1500),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { ok: boolean; service: string };
  if (!body.ok || body.service !== 'codex-dsh-bridge')
    throw new Error('PORT_OWNED_BY_ANOTHER_SERVICE');
  return body;
}
async function main() {
  if (command === 'help') {
    console.log(
      'Commands: init --root /project [--root /other], serve, start, stop, health, doctor, examples, launchd-install, launchd-uninstall. All accept --config /absolute/config.json',
    );
    return;
  }
  if (command === 'init') {
    const roots = args.flatMap((a, i) =>
      a === '--root' && args[i + 1] ? [args[i + 1]!] : [],
    );
    await initConfig(configPath, roots);
    console.log(
      `Created ${configPath} (0600). No existing configuration was changed.`,
    );
    return;
  }
  const config = await loadConfig(configPath);
  const redact = redactor([
    ...Object.values(config.tokens),
    ...Object.values(config.codex.env),
    ...Object.values(config.dsh.env),
  ]);
  if (command === 'health') {
    console.log(JSON.stringify(await health(config)));
    return;
  }
  if (command === 'doctor') {
    const report = await doctor(config, redact);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (command === 'examples') {
    const destination = join(config.stateDir, 'connections');
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const toml = `[mcp_servers.agent_bridge]\nurl = "http://127.0.0.1:${config.port}/mcp/codex"\nbearer_token_env_var = "CODEX_DSH_BRIDGE_TOKEN"\n`;
    const yaml = `- insert:\n    - id: codex-dsh-bridge\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: agent_bridge\n        transport: streamable-http\n        url: http://127.0.0.1:${config.port}/mcp/dsh\n        headers:\n          Authorization: !!js '\`Bearer \${process.env.DSH_CODEX_BRIDGE_TOKEN}\`'\n`;
    await writeFile(join(destination, 'codex.toml'), toml, { mode: 0o600 });
    await writeFile(join(destination, 'dsh.patch.yml'), yaml, { mode: 0o600 });
    await writeFile(
      join(destination, 'tokens.env'),
      `export CODEX_DSH_BRIDGE_TOKEN='${config.tokens.codex}'\nexport DSH_CODEX_BRIDGE_TOKEN='${config.tokens.dsh}'\n`,
      { mode: 0o600 },
    );
    const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    await writeFile(
      join(destination, 'tokens.ps1'),
      `$env:CODEX_DSH_BRIDGE_TOKEN = ${psQuote(config.tokens.codex)}\n$env:DSH_CODEX_BRIDGE_TOKEN = ${psQuote(config.tokens.dsh)}\n`,
      { mode: 0o600 },
    );
    console.log(
      `Connection files generated in ${destination}; tokens were not printed. Load ${process.platform === 'win32' ? 'tokens.ps1' : 'tokens.env'} before launching clients.`,
    );
    return;
  }
  const cli = fileURLToPath(import.meta.url);
  if (command === 'start') {
    try {
      await health(config);
      console.log('Already healthy');
      return;
    } catch {
      /* launch */
    }
    const log = await open(join(config.stateDir, 'service.log'), 'a', 0o600);
    const child = spawn(
      process.execPath,
      [cli, 'serve', '--config', configPath],
      {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
        env: process.env,
      },
    );
    child.unref();
    await log.close();
    for (let i = 0; i < 60; i++) {
      await delay(250);
      try {
        await health(config);
        console.log('Bridge started');
        return;
      } catch {
        /* bounded startup */
      }
    }
    throw new Error('START_FAILED: inspect service.log');
  }
  if (command === 'stop') {
    await health(config);
    const res = await fetch(`http://127.0.0.1:${config.port}/admin/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.tokens.codex}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 202) throw new Error('STOP_DENIED: HTTP ' + res.status);
    for (let i = 0; i < 120; i++) {
      await delay(250);
      try {
        await health(config);
      } catch {
        console.log('Bridge stopped');
        return;
      }
    }
    throw new Error('STOP_TIMEOUT');
  }
  if (command === 'launchd-install' || command === 'launchd-uninstall') {
    if (process.platform === 'win32')
      throw new Error(
        'UNSUPPORTED_PLATFORM: launchd is macOS only; use start/stop or Task Scheduler',
      );
    const label = 'local.codex-dsh-bridge';
    const path = join(homedir(), 'Library/LaunchAgents', label + '.plist');
    const domain = `gui/${process.getuid!()}`;
    if (command === 'launchd-uninstall') {
      await exec('launchctl', ['bootout', `${domain}/${label}`]).catch(
        () => {},
      );
      await unlink(path).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
      console.log('LaunchAgent removed; state and credentials preserved');
      return;
    }
    const xml = (s: string) =>
      s
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath, cli, 'serve', '--config', configPath].map((s) => `<string>${xml(s)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(dirname(dirname(cli)))}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(config.stateDir, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(config.stateDir, 'service.log'))}</string></dict></plist>`;
    if (args.includes('--dry-run')) {
      console.log(plist);
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, plist, { mode: 0o600, flag: 'wx' });
    await exec('launchctl', ['bootstrap', domain, path]);
    console.log('LaunchAgent installed');
    return;
  }
  if (command !== 'serve') throw new Error('Unknown command: ' + command);
  try {
    process.umask(0o077);
  } catch {
    /* Windows has no POSIX umask */
  }
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  try {
    await chmod(config.stateDir, 0o700);
  } catch (e) {
    if (process.platform !== 'win32') throw e;
  }
  const release = await acquireLease(config.stateDir);
  const store = new Store(join(config.stateDir, 'tasks.sqlite'));
  try {
    // Orphan supervisors kill their group when their parent vanishes. Never
    // replay or release locks until those process groups have actually stopped.
    for (const task of store.all())
      if (task.workerPid) {
        for (let i = 0; i < 100 && groupAlive(task.workerPid); i++)
          await delay(100);
        if (groupAlive(task.workerPid))
          throw new Error('ORPHAN_WORKER_STILL_ALIVE: refusing recovery');
      }
    const preflight = await doctor(config, redact);
    if (!preflight.ok)
      throw new Error(
        'PREFLIGHT_FAILED: ' +
          JSON.stringify(preflight.checks.filter((c) => !c.ok)),
      );
    const manager = new Manager(
      store,
      config.allowedRoots,
      {
        codex: new CodexExecutor(config, redact),
        dsh: new DshExecutor(config, redact),
      },
      redact,
      config.taskTimeoutMs,
    );
    manager.recover((pid) => !groupAlive(pid));
    const app = await serve(config, manager);
    console.error(`Bridge listening on 127.0.0.1:${config.port}`);
    await new Promise<void>((resolve) => {
      let closing = false;
      const close = () => {
        if (closing) return;
        closing = true;
        void app.close().then(resolve, (e) => {
          console.error(redact(String(e)));
          process.exitCode = 1;
          resolve();
        });
      };
      app.server.once('bridge-stop', close);
      process.on('SIGTERM', close);
      process.on('SIGINT', close);
    });
  } finally {
    store.close();
    await release();
  }
}
main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
