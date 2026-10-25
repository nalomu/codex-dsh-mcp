import { DatabaseSync } from 'node:sqlite';
import type { Task, Progress, Caller, Mail } from './types.js';
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, caller TEXT NOT NULL, ikey TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(caller,ikey));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, round INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,seq);
      CREATE INDEX IF NOT EXISTS events_task_kind ON events(task_id,kind,seq);
      CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, ikey TEXT NOT NULL, fingerprint TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, UNIQUE(task_id,ikey));`);
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
  compactEvents(id: string, after: number, limit: number) {
    const kinds = [
      'queued',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'cancelled',
      'interrupted',
      'recovered',
      'report',
      'mail_queued',
      'mail_delivered',
      'mail_resume_failed',
    ];
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE task_id=? AND seq>? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY seq LIMIT ?`,
      )
      .all(id, after, ...kinds, limit + 1);
    const hasMore = rows.length > limit;
    rows.splice(limit);
    const events = rows.map((r) => ({
      seq: Number(r.seq),
      taskId: id,
      round: Number(r.round),
      kind: String(r.kind),
      data: JSON.parse(String(r.data)),
      at: String(r.at),
    }));
    const last = Number(
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE task_id=?',
        )
        .get(id)!.seq,
    );
    return {
      events,
      nextCursor: hasMore ? events.at(-1)!.seq : Math.max(after, last),
      hasMore,
    };
  }
  enqueue(id: string, key: string, fingerprint: string, text: string) {
    const old = this.db
      .prepare('SELECT * FROM inbox WHERE task_id=? AND ikey=?')
      .get(id, key);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return { message: this.mail(old), created: false };
    }
    const pending = Number(
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM inbox WHERE task_id=? AND delivered_at IS NULL',
        )
        .get(id)!.n,
    );
    if (pending >= 32) throw new Error('MAILBOX_FULL');
    const row = this.db
      .prepare(
        'INSERT INTO inbox(task_id,ikey,fingerprint,text,created_at) VALUES(?,?,?,?,?) RETURNING *',
      )
      .get(id, key, fingerprint, text, new Date().toISOString())!;
    return { message: this.mail(row), created: true };
  }
  private mail(row: Record<string, unknown>): Mail {
    return {
      id: Number(row.id),
      taskId: String(row.task_id),
      text: String(row.text),
      createdAt: String(row.created_at),
      deliveredAt: row.delivered_at === null ? null : String(row.delivered_at),
    };
  }
  pending(id: string): Mail[] {
    return this.db
      .prepare(
        'SELECT * FROM inbox WHERE task_id=? AND delivered_at IS NULL ORDER BY id',
      )
      .all(id)
      .map((r) => this.mail(r));
  }
  delivered(ids: number[]) {
    for (const id of ids)
      this.db
        .prepare(
          'UPDATE inbox SET delivered_at=? WHERE id=? AND delivered_at IS NULL',
        )
        .run(new Date().toISOString(), id);
  }
  close() {
    this.db.close();
  }
}
