import { DatabaseSync } from 'node:sqlite';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** The OS releases this SQLite lock on process death, so stale PID reuse and
 * concurrent stale-file removal cannot admit two schedulers to the same state. */
export async function acquireLease(
  stateDir: string,
): Promise<() => Promise<void>> {
  const db = new DatabaseSync(join(stateDir, 'daemon-lease.sqlite'));
  try {
    db.exec(
      'PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lease (owner INTEGER)',
    );
  } catch {
    db.close();
    throw new Error(
      'SERVICE_ALREADY_RUNNING: another daemon owns this state directory',
    );
  }
  const path = join(stateDir, 'daemon.lock');
  try {
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    // Remove diagnostics while still holding the lease; never unlink the DB.
    try {
      await unlink(path);
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
  };
}
