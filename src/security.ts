import { realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitSnapshot } from './types.js';
export const exec = promisify(execFile);
export function contains(root: string, path: string) {
  const r = relative(root, path);
  return (
    r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`))
  );
}
export function overlaps(a: string, b: string) {
  return contains(a, b) || contains(b, a);
}
export async function workspace(path: string, roots: string[]) {
  if (!isAbsolute(path))
    throw new Error('WORKSPACE_DENIED: absolute directory required');
  const cwd = await realpath(path);
  if (!(await stat(cwd)).isDirectory())
    throw new Error('WORKSPACE_DENIED: not a directory');
  const allowed = await Promise.all(roots.map((r) => realpath(r)));
  if (!allowed.some((r) => contains(r, cwd)))
    throw new Error('WORKSPACE_DENIED: outside allowedRoots');
  let lockRoot = cwd;
  try {
    lockRoot = await realpath(
      (
        await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
          timeout: 5000,
        })
      ).stdout.trim(),
    );
  } catch {
    /* non-Git directory */
  }
  return { cwd, lockRoot };
}
export async function snapshot(cwd: string): Promise<GitSnapshot> {
  const warning =
    'Shared directory snapshot; changes are not attributable exclusively to this task. Existing edits are preserved.';
  try {
    const run = async (args: string[]) =>
      (
        await exec('git', ['-C', cwd, ...args], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    const [status, diffStat, head] = await Promise.all([
      run(['status', '--porcelain=v1', '--untracked-files=normal']),
      run(['diff', 'HEAD', '--stat']).catch(async () =>
        [
          await run(['diff', '--stat']),
          await run(['diff', '--cached', '--stat']),
        ].join(''),
      ),
      run(['rev-parse', 'HEAD']).catch(() => '(unborn)'),
    ]);
    return { available: true, status, diffStat, head: head.trim(), warning };
  } catch {
    return { available: false, warning };
  }
}
export function redactor(secrets: string[]) {
  const values = secrets
    .filter((s) => s.length >= 6)
    .sort((a, b) => b.length - a.length);
  return (value: unknown): string => {
    let s =
      typeof value === 'string'
        ? value
        : (JSON.stringify(value) ?? String(value));
    for (const secret of values) s = s.split(secret).join('[REDACTED]');
    return s
      .replace(/Bearer\s+[A-Za-z0-9_.~+\/-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(
        /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s,"'}]+/gi,
        '$1[REDACTED]',
      );
  };
}
export function childEnv(extra: Record<string, string>) {
  const result: NodeJS.ProcessEnv = {};
  const passthrough = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'USER',
    'SHELL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
  ];
  // Windows agents and the .cmd shims they may call need the native environment.
  const windows = [
    'SystemRoot',
    'windir',
    'ComSpec',
    'PATHEXT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'PROGRAMDATA',
    'USERNAME',
    'USERDOMAIN',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'OS',
  ];
  for (const key of process.platform === 'win32'
    ? [...passthrough, ...windows]
    : passthrough)
    if (process.env[key]) result[key] = process.env[key];
  for (const [k, v] of Object.entries(extra)) {
    if (/BRIDGE|MCP.*TOKEN/i.test(k))
      throw new Error('Child environment cannot contain bridge credentials');
    result[k] = v;
  }
  return result;
}

/** Buffer complete stderr lines so a credential split over chunks is redacted
 * before any fragment is persisted. Oversized lines are discarded as a whole. */
export function lineSink(
  redact: (value: unknown) => string,
  emit: (text: string) => void,
  limit = 65536,
) {
  let line = '';
  let discarded = false;
  return {
    write(chunk: string) {
      for (const part of chunk.split(/(?<=\n)/)) {
        if (!discarded) line += part;
        if (line.length > limit) {
          line = '';
          discarded = true;
        }
        if (part.endsWith('\n')) {
          emit(
            discarded
              ? '[stderr line exceeded limit]'
              : redact(line).slice(0, 8000),
          );
          line = '';
          discarded = false;
        }
      }
    },
    end() {
      if (discarded) emit('[stderr line exceeded limit]');
      else if (line) emit(redact(line).slice(0, 8000));
      line = '';
      discarded = false;
    },
  };
}
