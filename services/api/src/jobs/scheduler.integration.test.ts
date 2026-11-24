import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../test/db-helper.js';
import { PgTaskLock, Scheduler } from './scheduler.js';

let t: TestDb;
let pool: pg.Pool;
beforeAll(async () => {
  t = await createTestDb();
  pool = new pg.Pool({ connectionString: t.appUrl, max: 6 });
  pool.on('error', () => undefined);
});
afterAll(async () => {
  await pool.end();
  await t.drop();
});

describe('PgTaskLock (Postgres advisory lock)', () => {
  it('lets one holder in at a time for the same task, and a different task freely', async () => {
    const lock = new PgTaskLock(pool);
    const first = await lock.tryAcquire('poll-replies');
    expect(first).not.toBeNull();
    expect(await lock.tryAcquire('poll-replies')).toBeNull();
    const other = await lock.tryAcquire('purge');
    expect(other).not.toBeNull();
    await other?.();
    await first?.();
    const again = await lock.tryAcquire('poll-replies');
    expect(again).not.toBeNull();
    await again?.();
  });

  it('is shared between two lock objects, as between two API processes', async () => {
    const otherPool = new pg.Pool({ connectionString: t.appUrl, max: 2 });
    try {
      const a = new PgTaskLock(pool);
      const b = new PgTaskLock(otherPool);
      const held = await a.tryAcquire('shared');
      expect(await b.tryAcquire('shared')).toBeNull();
      await held?.();
      const taken = await b.tryAcquire('shared');
      expect(taken).not.toBeNull();
      await taken?.();
    } finally {
      await otherPool.end();
    }
  });

  it('releases the lock when a task fails, and does not use up connections', async () => {
    const scheduler = new Scheduler({ lock: new PgTaskLock(pool), log: { info: () => undefined, warn: () => undefined } });
    scheduler.add({ name: 'boom', everyMs: 1000, run: () => Promise.reject(new Error('x')) });
    for (let i = 0; i < 12; i++) expect((await scheduler.runNow('boom')).status).toBe('failed');
    const free = await new PgTaskLock(pool).tryAcquire('boom');
    expect(free).not.toBeNull();
    await free?.();
  });

  it('runs a task once when two schedulers try at the same moment', async () => {
    let runs = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const make = () => {
      const s = new Scheduler({ lock: new PgTaskLock(pool), log: { info: () => undefined, warn: () => undefined } });
      s.add({ name: 'once', everyMs: 1000, run: async () => { runs += 1; await gate; } });
      return s;
    };
    const [one, two] = [make(), make()];
    const first = one.runNow('once');
    await new Promise((r) => setTimeout(r, 100)); // the first holds the lock and waits at the gate
    expect(await two.runNow('once')).toEqual({ status: 'busy' });
    release();
    expect((await first).status).toBe('ran');
    expect(runs).toBe(1);
  });
});
