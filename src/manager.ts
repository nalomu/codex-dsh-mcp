import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Store } from './store.js';
import { overlaps, workspace, snapshot } from './security.js';
import { terminal, type Caller, type Task, type Executor } from './types.js';
export class Manager {
  readonly changes = new EventEmitter();
  private active = new Map<
    string,
    { task: Task; abort: AbortController; done: Promise<void> }
  >();
  private stopping = false;
  constructor(
    readonly store: Store,
    readonly roots: string[],
    readonly executors: Record<Caller, Executor>,
    readonly redact: (v: unknown) => string,
    readonly timeoutMs = 1800000,
  ) {
    this.changes.setMaxListeners(0);
  }
  recover(workerStopped?: (pid: number) => boolean) {
    for (const task of this.store.all()) {
      const wasActive = !terminal(task.state);
      if (task.workerPid !== undefined) {
        if (!workerStopped?.(task.workerPid))
          throw new Error(
            'ORPHAN_WORKER_STILL_ALIVE: recovery requires verified process-group exit',
          );
        delete task.workerPid;
      } else if (!wasActive) continue;
      if (wasActive) {
        task.state = 'interrupted';
        const round = task.rounds.at(-1)!;
        round.state = 'interrupted';
        round.endedAt = new Date().toISOString();
        round.error =
          'Service restarted; execution was not replayed. Inspect files before continuing.';
      }
      this.persist(task, 'recovered', { state: task.state, replayed: false });
    }
  }
  private persist(t: Task, kind: string, data: unknown) {
    t.updatedAt = new Date().toISOString();
    this.store.atomic(() => {
      this.store.save(t);
      this.store.event(
        t,
        kind,
        JSON.parse(
          JSON.stringify(data, (_k, v) =>
            typeof v === 'string' ? this.redact(v) : v,
          ),
        ),
      );
    });
    this.changes.emit(t.id);
  }
  owned(caller: Caller, id: string) {
    const t = this.store.get(id);
    if (!t || t.caller !== caller) throw new Error('TASK_NOT_FOUND');
    return t;
  }
  async run(caller: Caller, prompt: string, path: string, key: string) {
    if (this.stopping) throw new Error('SERVICE_STOPPING');
    const { cwd, lockRoot } = await workspace(path, this.roots);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([cwd, prompt]))
      .digest('hex');
    const prior = this.store.byKey(caller, key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error('IDEMPOTENCY_CONFLICT');
      return prior;
    }
    const now = new Date().toISOString();
    const t: Task = {
      id: randomUUID(),
      caller,
      target: caller === 'codex' ? 'dsh' : 'codex',
      cwd,
      lockRoot,
      key,
      fingerprint,
      createdAt: now,
      updatedAt: now,
      state: 'queued',
      rounds: [{ number: 1, prompt: this.redact(prompt), state: 'queued' }],
    };
    this.persist(t, 'queued', { target: t.target });
    queueMicrotask(() => this.pump());
    return t;
  }
  async continue(caller: Caller, id: string, prompt: string, key: string) {
    if (this.stopping) throw new Error('SERVICE_STOPPING');
    const t = this.owned(caller, id);
    await workspace(t.cwd, this.roots);
    // Reload after asynchronous validation so concurrent continue requests cannot both win.
    const latest = this.owned(caller, id);
    const duplicate = latest.rounds.find((r) => r.key === key);
    if (duplicate) {
      if (duplicate.prompt !== this.redact(prompt))
        throw new Error('IDEMPOTENCY_CONFLICT');
      return latest;
    }
    if (!terminal(latest.state)) throw new Error('TASK_BUSY');
    if (latest.workerPid) throw new Error('WORKER_NOT_STOPPED');
    // Interrupted admission may not yet have created a session; explicit continue
    // is allowed to create it, while restart itself never replays work.
    latest.state = 'queued';
    latest.rounds.push({
      number: latest.rounds.length + 1,
      prompt: this.redact(prompt),
      state: 'queued',
      ...{ key },
    });
    this.persist(latest, 'queued', { continuation: true });
    queueMicrotask(() => this.pump());
    return latest;
  }
  status(caller: Caller, id: string, after = 0, limit = 100) {
    const task = this.owned(caller, id);
    const events = this.store.events(id, after, limit);
    return {
      task,
      events,
      nextCursor: events.at(-1)?.seq ?? after,
      hasMore: events.length === limit,
    };
  }
  async wait(caller: Caller, id: string, after = 0, timeout = 25000) {
    const ready = () => {
      const s = this.status(caller, id, after);
      return s.events.length > 0 || terminal(s.task.state);
    };
    if (!ready())
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.changes.off(id, check);
          resolve();
        };
        const check = () => {
          if (ready()) finish();
        };
        const timer = setTimeout(finish, Math.min(timeout, 25000));
        this.changes.on(id, check);
        check();
      });
    return this.status(caller, id, after);
  }
  async cancel(caller: Caller, id: string) {
    const t = this.owned(caller, id);
    if (terminal(t.state)) return t;
    const live = this.active.get(id);
    if (live) {
      live.abort.abort(new Error('TASK_CANCELLED'));
      await live.done;
    } else {
      t.state = 'cancelled';
      t.rounds.at(-1)!.state = 'cancelled';
      t.rounds.at(-1)!.endedAt = new Date().toISOString();
      this.persist(t, 'cancelled', {});
    }
    return this.owned(caller, id);
  }
  private pump() {
    if (this.stopping) return;
    for (const t of this.store.all().filter((t) => t.state === 'queued')) {
      if (
        [...this.active.values()].some((a) =>
          overlaps(a.task.lockRoot, t.lockRoot),
        ) ||
        this.store
          .all()
          .some(
            (a) =>
              a.state === 'interrupted' &&
              a.workerPid &&
              overlaps(a.lockRoot, t.lockRoot),
          )
      )
        continue;
      const abort = new AbortController();
      const live = { task: t, abort, done: Promise.resolve() };
      this.active.set(t.id, live);
      live.done = this.execute(t, abort).finally(() => {
        this.active.delete(t.id);
        this.pump();
      });
    }
  }
  private async execute(t: Task, abort: AbortController) {
    let stopped = true;
    const round = t.rounds.at(-1)!;
    const timer = setTimeout(
      () => abort.abort(new Error('TASK_TIMEOUT')),
      this.timeoutMs,
    );
    try {
      const validated = await workspace(t.cwd, this.roots);
      if (validated.lockRoot !== t.lockRoot)
        throw new Error('WORKSPACE_CHANGED');
      t.state = 'running';
      round.state = 'running';
      round.startedAt = new Date().toISOString();
      round.before = await snapshot(t.cwd);
      this.persist(t, 'running', { before: round.before });
      if (abort.signal.aborted) throw abort.signal.reason;
      const result = await this.executors[t.target].run({
        cwd: t.cwd,
        sessionId: t.sessionId,
        prompt: round.prompt,
        signal: abort.signal,
        emit: (kind, data) => this.persist(t, kind, data),
        session: (id) => {
          t.sessionId = id;
          this.persist(t, 'session', { sessionId: id });
        },
        worker: (pid) => {
          t.workerPid = pid;
          this.persist(t, 'worker', { pid });
        },
      });
      if (abort.signal.aborted) throw abort.signal.reason;
      t.state = 'succeeded';
      round.result = this.redact(result);
    } catch (e) {
      const reason = abort.signal.aborted ? abort.signal.reason : e;
      t.state = String(reason).includes('TASK_CANCELLED')
        ? 'cancelled'
        : 'failed';
      round.error = this.redact(String(reason));
      if (String(e).includes('WORKER_NOT_STOPPED')) {
        stopped = false;
        t.state = 'interrupted';
      }
    } finally {
      clearTimeout(timer);
      round.state = t.state;
      round.endedAt = new Date().toISOString();
      round.after = await snapshot(t.cwd);
      if (stopped) delete t.workerPid;
      this.persist(t, t.state, {
        result: round.result,
        error: round.error,
        after: round.after,
      });
    }
  }
  async close() {
    this.stopping = true;
    await Promise.all(
      [...this.active.values()].map(async (a) => {
        a.abort.abort(new Error('SERVICE_STOPPING'));
        await a.done;
      }),
    );
  }
}
