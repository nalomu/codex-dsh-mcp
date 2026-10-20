import { DatabaseSync } from 'node:sqlite';
import type { Task, Progress, Caller } from './types.js';
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, caller TEXT NOT NULL, ikey TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(caller,ikey));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, round INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,seq);`);
  }
  get(id: string): Task | undefined {
    const r = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
    return r ? JSON.parse(r.body as string) : undefined;
  }
  byKey(caller: Caller, key: string): Task | undefined {
    const r = this.db
      .prepare('SELECT body FROM tasks WHERE caller=? AND ikey=?')
      .get(caller, key);
    return r ? JSON.parse(r.body as string) : undefined;
  }
  save(t: Task) {
    this.db
      .prepare(
        'INSERT INTO tasks(id,caller,ikey,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(t.id, t.caller, t.key, JSON.stringify(t));
  }
  all(): Task[] {
    return this.db
      .prepare('SELECT body FROM tasks ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  list(caller: Caller, cursor = 0, limit = 20) {
    const rows = this.db
      .prepare(
        'SELECT rowid,body FROM tasks WHERE caller=? AND rowid>? ORDER BY rowid LIMIT ?',
      )
      .all(caller, cursor, limit + 1);
    const more = rows.length > limit;
    rows.splice(limit);
    return {
      tasks: rows.map((r) => JSON.parse(r.body as string)),
      nextCursor: more ? Number(rows.at(-1)!.rowid) : null,
    };
  }
  event(task: Task, kind: string, data: unknown) {
    this.db
      .prepare(
        'INSERT INTO events(task_id,round,kind,data,at) VALUES(?,?,?,?,?)',
      )
      .run(
        task.id,
        task.rounds.length,
        kind,
        JSON.stringify(data),
        new Date().toISOString(),
      );
  }
  events(id: string, after = 0, limit = 100): Progress[] {
    return this.db
      .prepare(
        'SELECT * FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?',
      )
      .all(id, after, limit)
      .map((r) => ({
        seq: Number(r.seq),
        taskId: r.task_id as string,
        round: Number(r.round),
        kind: r.kind as string,
        data: JSON.parse(r.data as string),
        at: r.at as string,
      }));
  }
  atomic(fn: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
