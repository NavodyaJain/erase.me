import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler, type TaskLock } from './scheduler.js';

/** A lock that lives in memory. One holder per task name, like the Postgres lock. */
class MemoryLock implements TaskLock {
  readonly held = new Set<string>();
  acquired = 0;
  released = 0;
  tryAcquire(name: string): Promise<(() => Promise<void>) | null> {
    if (this.held.has(name)) return Promise.resolve(null);
    this.held.add(name);
    this.acquired += 1;
    return Promise.resolve(() => {
      this.held.delete(name);
      this.released += 1;
      return Promise.resolve();
    });
  }
}

function setup() {
  const lock = new MemoryLock();
  const logs: Array<{ level: 'info' | 'warn'; o: Record<string, unknown>; msg: string }> = [];
  const log = {
    info: (o: Record<string, unknown>, msg: string) => logs.push({ level: 'info', o, msg }),
    warn: (o: Record<string, unknown>, msg: string) => logs.push({ level: 'warn', o, msg }),
  };
  const scheduler = new Scheduler({ lock, log, initialDelayMs: 1000 });
  return { lock, logs, scheduler };
}

describe('Scheduler.runNow', () => {
  it('runs the task, logs its counts, and releases the lock', async () => {
    const { scheduler, lock, logs } = setup();
    scheduler.add({ name: 'count', everyMs: 60_000, run: () => Promise.resolve({ checked: 3, replied: 1 }) });
    expect(await scheduler.runNow('count')).toEqual({ status: 'ran', counts: { checked: 3, replied: 1 } });
    expect(lock.held.size).toBe(0);
    expect(logs).toEqual([{ level: 'info', o: { task: 'count', checked: 3, replied: 1 }, msg: 'task finished' }]);
  });

  it('does nothing when another process holds the lock', async () => {
    const { scheduler, lock } = setup();
    const run = vi.fn(() => Promise.resolve());
    scheduler.add({ name: 'busy', everyMs: 60_000, run });
    lock.held.add('busy');
    expect(await scheduler.runNow('busy')).toEqual({ status: 'busy' });
    expect(run).not.toHaveBeenCalled();
    expect(lock.held.has('busy')).toBe(true); // the other holder's lock is untouched
  });

  it('never runs a task twice at once in the same process', async () => {
    const { scheduler } = setup();
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    scheduler.add({ name: 'slow', everyMs: 60_000, run });
    const first = scheduler.runNow('slow');
    await Promise.resolve();
    expect(await scheduler.runNow('slow')).toEqual({ status: 'busy' });
    release();
    expect((await first).status).toBe('ran');
    expect(run).toHaveBeenCalledTimes(1);
    // and it can run again afterwards
    const again = scheduler.runNow('slow');
    await Promise.resolve();
    release();
    expect((await again).status).toBe('ran');
  });

  it('logs a failure by task name and error class only, releases the lock, and runs again next time', async () => {
    const { scheduler, lock, logs } = setup();
    let fail = true;
    scheduler.add({
      name: 'flaky',
      everyMs: 60_000,
      run: () => (fail ? Promise.reject(new TypeError('could not read someone@example.com subject: erase my data')) : Promise.resolve({ ok: 1 })),
    });
    expect(await scheduler.runNow('flaky')).toEqual({ status: 'failed', error: 'TypeError' });
    expect(lock.held.size).toBe(0);
    expect(JSON.stringify(logs)).not.toMatch(/someone@example|erase my data/);
    expect(logs[0]).toEqual({ level: 'warn', o: { task: 'flaky', error: 'TypeError' }, msg: 'task failed' });
    fail = false;
    expect((await scheduler.runNow('flaky')).status).toBe('ran');
  });

  it('reports a lock that cannot be taken as a failure, not a crash', async () => {
    const lock: TaskLock = { tryAcquire: () => Promise.reject(new Error('connection refused to db.internal:5432')) };
    const logs: string[] = [];
    const scheduler = new Scheduler({ lock, log: { info: () => undefined, warn: (_o, m) => logs.push(m) } });
    scheduler.add({ name: 't', everyMs: 1000, run: () => Promise.resolve() });
    expect(await scheduler.runNow('t')).toEqual({ status: 'failed', error: 'Error' });
    expect(logs).toEqual(['task lock failed']);
  });

  it('refuses a task name it does not know, and a task added twice', async () => {
    const { scheduler } = setup();
    await expect(scheduler.runNow('nope')).rejects.toThrow(/no task named/);
    scheduler.add({ name: 'once', everyMs: 1000, run: () => Promise.resolve() });
    expect(() => scheduler.add({ name: 'once', everyMs: 1000, run: () => Promise.resolve() })).toThrow(/already scheduled/);
  });
});

describe('Scheduler timers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs soon after start, then on its interval, and stops when stopped', async () => {
    const { scheduler } = setup();
    const run = vi.fn(() => Promise.resolve({ n: 1 }));
    scheduler.add({ name: 'tick', everyMs: 15 * 60_000, run });
    scheduler.start();
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000); // the first run, after the initial delay
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * 15 * 60_000);
    expect(run).toHaveBeenCalledTimes(4);

    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(run).toHaveBeenCalledTimes(4);
    expect(scheduler.isStopped).toBe(true);
  });

  it('waits for a run that is in progress when it is stopped', async () => {
    const { scheduler } = setup();
    let release: () => void = () => undefined;
    let finished = false;
    scheduler.add({ name: 'long', everyMs: 60_000, run: () => new Promise<void>((resolve) => (release = () => { finished = true; resolve(); })) });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    const stopping = scheduler.stop();
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
  });

  it('keeps going after one run fails', async () => {
    const { scheduler } = setup();
    let calls = 0;
    scheduler.add({ name: 'sometimes', everyMs: 60_000, run: () => (++calls === 1 ? Promise.reject(new Error('x')) : Promise.resolve()) });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);
    await scheduler.stop();
  });
});
