import type pg from 'pg';

/** Stops two copies of a task running at once, across processes. */
export interface TaskLock {
  /** Returns a release function if this caller now holds the lock, or null if someone else does. */
  tryAcquire(name: string): Promise<(() => Promise<void>) | null>;
}

export interface ScheduledTask {
  name: string;
  everyMs: number;
  /** Idempotent. Returns counts only, which are logged: never an address, a subject, an id or any message content. */
  run(): Promise<object | void>;
}

export type RunOutcome = { status: 'ran'; counts: object | void } | { status: 'busy' } | { status: 'failed'; error: string };

export interface SchedulerDeps {
  lock: TaskLock;
  log: { info(o: Record<string, unknown>, msg: string): void; warn(o: Record<string, unknown>, msg: string): void };
  /** How long after start the first run happens. Default 10 seconds. */
  initialDelayMs?: number;
}

/**
 * Runs background tasks inside the API process (TRD 6.5, with BullMQ and Redis deferred). Each task runs on its own
 * interval, never twice at the same time in this process, and holds a lock while it runs so a second API process skips
 * it. A failure is logged by task name and error class only (an error message can quote what it was handling) and the
 * next run goes ahead as normal. `runNow` is how tests, and the e2e stack, run a task without waiting for a timer.
 */
export class Scheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly running = new Map<string, Promise<RunOutcome>>();
  private timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];
  private stopped = true;

  constructor(private readonly deps: SchedulerDeps) {}

  add(task: ScheduledTask): void {
    if (this.tasks.has(task.name)) throw new Error(`task ${task.name} is already scheduled`);
    this.tasks.set(task.name, task);
  }

  start(): void {
    this.stopped = false;
    for (const task of this.tasks.values()) {
      const first = setTimeout(() => void this.runNow(task.name), Math.min(task.everyMs, this.deps.initialDelayMs ?? 10_000));
      const every = setInterval(() => void this.runNow(task.name), task.everyMs);
      first.unref();
      every.unref();
      this.timers.push(first, every);
    }
  }

  /** Stops the timers and waits for any run in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) {
      clearTimeout(t as ReturnType<typeof setTimeout>);
      clearInterval(t as ReturnType<typeof setInterval>);
    }
    this.timers = [];
    await Promise.allSettled([...this.running.values()]);
  }

  runNow(name: string): Promise<RunOutcome> {
    const task = this.tasks.get(name);
    if (!task) return Promise.reject(new Error(`no task named ${name}`));
    if (this.running.has(name)) return Promise.resolve({ status: 'busy' });
    const run = this.execute(task).finally(() => this.running.delete(name));
    this.running.set(name, run);
    return run;
  }

  private async execute(task: ScheduledTask): Promise<RunOutcome> {
    let release: (() => Promise<void>) | null;
    try {
      release = await this.deps.lock.tryAcquire(task.name);
    } catch (err) {
      this.deps.log.warn({ task: task.name, error: errorName(err) }, 'task lock failed');
      return { status: 'failed', error: errorName(err) };
    }
    if (!release) return { status: 'busy' };
    try {
      const counts = await task.run();
      this.deps.log.info({ task: task.name, ...(counts && typeof counts === 'object' ? counts : {}) }, 'task finished');
      return { status: 'ran', counts };
    } catch (err) {
      this.deps.log.warn({ task: task.name, error: errorName(err) }, 'task failed');
      return { status: 'failed', error: errorName(err) };
    } finally {
      await release().catch(() => undefined);
    }
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'Error');

/**
 * A Postgres advisory lock held on its own connection for the length of a run. If the process dies the connection
 * closes and Postgres releases the lock, so a crash never leaves a task locked.
 */
export class PgTaskLock implements TaskLock {
  constructor(private readonly pool: pg.Pool) {}

  async tryAcquire(name: string): Promise<(() => Promise<void>) | null> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS ok', [`erase:${name}`]);
      if (!rows[0]?.ok) {
        client.release();
        return null;
      }
    } catch (err) {
      client.release(true);
      throw err;
    }
    return async () => {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [`erase:${name}`]);
        client.release();
      } catch {
        client.release(true); // drop the connection: that releases the lock too
      }
    };
  }
}
