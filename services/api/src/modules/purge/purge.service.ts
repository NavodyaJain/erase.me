import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';

/** What a purge function reports: numbers only. Never an id, an address or any text. */
export type Counts = Record<string, number>;

function asCounts(value: unknown): Counts {
  const out: Counts = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** The only code that calls the purge functions. The app role has no DELETE, so this is the only way anything is removed. */
export function createPurgeRepository(db: Db) {
  const call = async (query: SQL): Promise<Counts> => {
    const res = await db.execute<{ r: unknown }>(query);
    return asCounts(res.rows[0]?.r);
  };
  return {
    users: (limit: number, dryRun: boolean) => call(sql`SELECT public.purge_users(${limit}::int, ${dryRun}::boolean) AS r`),
    user: (userId: string, limit: number, dryRun: boolean) => call(sql`SELECT public.purge_user(${userId}::text, ${limit}::int, ${dryRun}::boolean) AS r`),
    inboxes: (limit: number, dryRun: boolean) => call(sql`SELECT public.purge_inboxes(${limit}::int, ${dryRun}::boolean) AS r`),
    sessions: (limit: number, dryRun: boolean) => call(sql`SELECT public.purge_sessions(${limit}::int, ${dryRun}::boolean) AS r`),
    requests: (retentionDays: number, limit: number, dryRun: boolean) =>
      call(sql`SELECT public.purge_requests(${retentionDays}::int, ${limit}::int, ${dryRun}::boolean) AS r`),
  };
}
export type PurgeRepository = ReturnType<typeof createPurgeRepository>;

export interface PurgeOptions {
  /** Closed requests older than this are deleted. 0 turns it off (the default). */
  requestRetentionDays: number;
}

/** How often the purge runs. Each run is bounded by batch limits and is safe to repeat, so nothing needs it faster. */
export const PURGE_EVERY_MS = 60 * 60_000;

export type PurgeRunCounts = Record<'sessions' | 'inboxes' | 'users' | 'requests', Counts>;

/**
 * Runs the purge functions: expired sessions and sign-in attempts, disconnected inboxes past their retention, deleted accounts
 * past the undo period, and (only when switched on) old closed requests. Safe to run again at any time. Returns counts only.
 */
export class PurgeService {
  constructor(
    private readonly repo: PurgeRepository,
    private readonly opts: PurgeOptions,
  ) {}

  async runOnce(o: { dryRun?: boolean } = {}): Promise<PurgeRunCounts> {
    const dryRun = o.dryRun ?? false;
    return {
      sessions: await this.repo.sessions(1000, dryRun),
      inboxes: await this.repo.inboxes(100, dryRun),
      users: await this.repo.users(25, dryRun),
      requests: await this.repo.requests(this.opts.requestRetentionDays, 200, dryRun),
    };
  }

  /** "Delete now": removes one person's data in batches. Returns whether the tombstone has been written. */
  async purgeUserNow(userId: string): Promise<{ done: boolean }> {
    for (let i = 0; i < 20; i += 1) {
      const counts = await this.repo.user(userId, 1000, false);
      if (counts['done'] === 1) return { done: true };
    }
    return { done: false };
  }
}

/** The scheduled task. The scheduler holds a Postgres advisory lock on its name while it runs, so a second process skips it. */
export const purgeTask = (purge: PurgeService) => ({ name: 'purge', everyMs: PURGE_EVERY_MS, run: () => purge.runOnce() });
