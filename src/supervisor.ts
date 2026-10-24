// Separate process-group leader. A daemon crash must not leave an agent editing files.
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const windows = process.platform === 'win32';
/** Resolve a System32 executable without depending on the caller's PATH. */
const systemExe = (name: string) => {
  if (!windows) return name;
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(root, 'System32', name);
};

const parent = process.ppid;
const [command, ...args] = process.argv.slice(2);
if (!command) process.exit(2);
const child = spawn(command!, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
  windowsHide: true,
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
const killGroup = () => {
  if (windows) {
    // taskkill /T walks the whole tree rooted at this supervisor, including the
    // agent process and anything it already spawned.
    try {
      spawnSync(
        systemExe('taskkill.exe'),
        ['/PID', String(process.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true, timeout: 15000 },
      );
    } catch {
      /* already gone */
    }
    process.exit(1);
  }
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    process.exit(1);
  }
};
const watch = setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    killGroup();
  }
}, 500);
child.once('error', () => {
  process.stderr.write('Unable to start configured agent executable\n');
  killGroup();
});
// Do not exit on child exit: descendants may still be alive. The daemon kills
// the whole group after closing the protocol, then releases the workspace lock.
child.once('exit', (code, signal) => {
  process.stdout.end();
  process.stderr.write(`Agent exited (${code ?? signal})\n`);
});
process.on('SIGTERM', () => {
  clearInterval(watch);
  killGroup();
});
process.stdin.once('end', () => {
  child.stdin.end();
});
