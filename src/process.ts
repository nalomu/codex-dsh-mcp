import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { childEnv, lineSink } from './security.js';
import type { RuntimeConfig } from './types.js';

const windows = process.platform === 'win32';

/** Resolve a System32 executable without depending on the daemon's PATH. */
const systemExe = (name: string) => {
  if (!windows) return name;
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(root, 'System32', name);
};

/** Detect a live Windows PID from `tasklist /FO CSV /NH` output. */
const windowsAlive = (pid: number) => {
  try {
    const out = execFileSync(
      systemExe('tasklist.exe'),
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    );
    return out
      .split(/\r?\n/)
      .some(
        (line) =>
          line.trim().startsWith('"') &&
          line.split('","')[1]?.replaceAll('"', '') === String(pid),
      );
  } catch {
    return false;
  }
};

/** Force-terminate a whole Windows process tree; already-dead trees are fine. */
export const killTree = (pid: number) => {
  if (!windows) return;
  try {
    execFileSync(systemExe('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
  } catch {
    /* the tree is already gone */
  }
};

export const groupAlive = (pid: number) => {
  if (windows) return windowsAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw e;
  }
};

export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ManagedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private exit: Promise<unknown>;
  private stopPromise?: Promise<void>;
  constructor(
    runtime: RuntimeConfig,
    cwd: string,
    env: Record<string, string>,
    redact: (v: unknown) => string,
    log: (s: string) => void,
  ) {
    this.child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../dist/supervisor.js', import.meta.url)),
        runtime.command,
        ...runtime.args,
      ],
      {
        cwd,
        // POSIX relies on a dedicated process group; Windows uses taskkill /T.
        detached: !windows,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv({ ...runtime.env, ...env }),
      },
    );
    this.exit = once(this.child, 'exit').catch(() => undefined);
    const stderr = lineSink(redact, log);
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text: string) => stderr.write(text));
    this.child.stderr.once('end', () => stderr.end());
    this.child.stdin.on('error', () => {});
  }
  get pid() {
    if (!this.child.pid) throw new Error('EXECUTOR_START_FAILED');
    return this.child.pid;
  }
  stop() {
    return (this.stopPromise ??= this.stopInner());
  }
  private async stopInner() {
    const pid = this.child.pid;
    if (!pid) return;
    if (windows) {
      // No POSIX process groups: terminate the supervisor's whole tree, then
      // verify nothing survives before the workspace lock is released.
      killTree(pid);
      await Promise.race([this.exit, delay(1000)]);
      if (groupAlive(pid)) killTree(pid);
      await Promise.race([this.exit, delay(10000)]);
      for (let i = 0; i < 100 && groupAlive(pid); i++) await delay(50);
      if (groupAlive(pid))
        throw new Error(`WORKER_NOT_STOPPED: process tree ${pid}`);
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (e) {
      if (!['ESRCH', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? ''))
        throw e;
    }
    await Promise.race([this.exit, delay(1000)]);
    if (groupAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (e) {
        if (
          !['ESRCH', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')
        )
          throw e;
      }
    }
    await this.exit;
    // Fail closed rather than release a directory while an agent can still write.
    for (let i = 0; i < 100 && groupAlive(pid); i++) await delay(50);
    if (groupAlive(pid))
      throw new Error(`WORKER_NOT_STOPPED: process group ${pid}`);
  }
}

export class Rpc {
  private next = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer?: NodeJS.Timeout;
    }
  >();
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => unknown = () => {
    throw new Error('Unsupported server request');
  };
  private buffer = '';
  private dead?: Error;
  private decoder = new StringDecoder('utf8');
  constructor(readonly proc: ManagedProcess) {
    proc.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      if (this.buffer.length > 8 * 1024 * 1024) {
        this.fail(new Error('RPC_MESSAGE_TOO_LARGE'));
        void proc.stop().catch(() => {});
        return;
      }
      let pos;
      while ((pos = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, pos);
        this.buffer = this.buffer.slice(pos + 1);
        if (line.trim()) this.receive(line);
      }
    });
    proc.child.stdout.once('end', () =>
      this.fail(new Error('EXECUTOR_DISCONNECTED')),
    );
    proc.child.once('error', (e) => this.fail(e));
    proc.child.once('exit', () => this.fail(new Error('EXECUTOR_EXITED')));
  }
  private receive(line: string) {
    try {
      const m = JSON.parse(line);
      if (m.method) {
        if (m.id !== undefined) {
          Promise.resolve()
            .then(() => this.onRequest(m.method, m.params))
            .then(
              (result) => this.send({ id: m.id, result: result ?? {} }),
              (e) =>
                this.send({
                  id: m.id,
                  error: { code: -32601, message: String(e) },
                }),
            )
            .catch(() => {});
        } else this.onNotification(m.method, m.params);
      } else {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          m.error
            ? p.reject(new Error(`RPC_ERROR: ${m.error.message}`))
            : p.resolve(m.result);
        }
      }
    } catch (e) {
      this.fail(new Error(`RPC_INVALID_MESSAGE: ${String(e)}`));
      void this.proc.stop().catch(() => {});
    }
  }
  private send(body: unknown) {
    if (this.dead) throw this.dead;
    this.proc.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', ...(body as object) }) + '\n',
    );
  }
  request<T = any>(
    method: string,
    params: unknown,
    timeout = 30000,
  ): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`RPC_TIMEOUT: ${method}`));
          }, timeout)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }
  notify(method: string, params: unknown = {}) {
    this.send({ method, params });
  }
  fail(e: Error) {
    this.dead = e;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}
