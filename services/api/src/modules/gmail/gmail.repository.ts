import { createHash } from 'node:crypto';
import { and, arrayOverlaps, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { newId } from '../../common/ids.js';
import type { Db } from '../../db/client.js';
import { companies, inboxes, scans, userCompanies, users } from '../../db/schema/index.js';

export interface InboxRow {
  id: string;
  userId: string;
  email: string;
  status: 'connected' | 'disconnected' | 'error';
  tokenCiphertext: string | null;
  tokenKeyId: string | null;
  scopes: string[];
  connectedAt: Date;
  lastScanAt: Date | null;
}

export interface ScanRow {
  id: string;
  inboxId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progressPct: number;
  foundCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  cursor: string | null;
  errorCode: string | null;
  createdAt: Date;
}

export interface Detection {
  domain: string;
  firstSeen: Date;
  lastSeen: Date;
  signals: string[];
}

export interface DetectedCompany {
  company: string;
  domain: string;
  firstSeen: Date;
  lastSeen: Date;
  signals: string[];
  status: 'active' | 'not_mine' | 'requested';
  mustKeep: boolean;
  category: string;
}

const inboxColumns = {
  id: inboxes.id,
  userId: inboxes.userId,
  email: inboxes.email,
  status: inboxes.status,
  tokenCiphertext: inboxes.tokenCiphertext,
  tokenKeyId: inboxes.tokenKeyId,
  scopes: inboxes.scopes,
  connectedAt: inboxes.connectedAt,
  lastScanAt: inboxes.lastScanAt,
};

const scanColumns = {
  id: scans.id,
  inboxId: scans.inboxId,
  status: scans.status,
  progressPct: scans.progressPct,
  foundCount: scans.foundCount,
  startedAt: scans.startedAt,
  finishedAt: scans.finishedAt,
  cursor: scans.cursor,
  errorCode: scans.errorCode,
  createdAt: scans.createdAt,
};

/** Slug from a registrable domain: `shop.co.in` -> `shop-co-in`. */
export function slugFor(domain: string): string {
  return domain.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** `my-shop.com` -> `My Shop`. A placeholder name for a company the catalog does not know yet. */
export function nameFor(domain: string): string {
  const label = domain.split('.')[0] ?? domain;
  return label
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The only code that touches inboxes, scans and detected companies. */
export function createGmailRepository(db: Db) {
  return {
    /** The user's sign-in address and every inbox address: senders that are the user themselves. */
    async listOwnAddresses(userId: string): Promise<string[]> {
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
      const boxes = await db.select({ email: inboxes.email }).from(inboxes).where(eq(inboxes.userId, userId));
      return [...new Set([u?.email, ...boxes.map((b) => b.email)].filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()))];
    },

    async listInboxes(userId: string): Promise<InboxRow[]> {
      return db.select(inboxColumns).from(inboxes).where(eq(inboxes.userId, userId)).orderBy(inboxes.connectedAt);
    },

    /** Ownership is part of the query: another user's inbox looks like a missing one. */
    async findOwnedInbox(userId: string, inboxId: string): Promise<InboxRow | undefined> {
      const [row] = await db
        .select(inboxColumns)
        .from(inboxes)
        .where(and(eq(inboxes.id, inboxId), eq(inboxes.userId, userId)));
      return row;
    },

    async findInbox(inboxId: string): Promise<InboxRow | undefined> {
      const [row] = await db.select(inboxColumns).from(inboxes).where(eq(inboxes.id, inboxId));
      return row;
    },

    async findInboxByEmail(userId: string, email: string): Promise<InboxRow | undefined> {
      const [row] = await db
        .select(inboxColumns)
        .from(inboxes)
        .where(and(eq(inboxes.userId, userId), eq(inboxes.email, email)));
      return row;
    },

    async countConnected(userId: string): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(inboxes)
        .where(and(eq(inboxes.userId, userId), ne(inboxes.status, 'disconnected')));
      return row?.n ?? 0;
    },

    async saveConnectedInbox(row: {
      id: string;
      userId: string;
      email: string;
      tokenCiphertext: string;
      tokenKeyId: string;
      scopes: string[];
      now: Date;
    }): Promise<void> {
      await db
        .insert(inboxes)
        .values({
          id: row.id,
          userId: row.userId,
          email: row.email,
          status: 'connected',
          tokenCiphertext: row.tokenCiphertext,
          tokenKeyId: row.tokenKeyId,
          scopes: row.scopes,
          connectedAt: row.now,
        })
        .onConflictDoUpdate({
          target: [inboxes.userId, inboxes.email],
          set: {
            status: 'connected',
            tokenCiphertext: row.tokenCiphertext,
            tokenKeyId: row.tokenKeyId,
            scopes: row.scopes,
            connectedAt: row.now,
            disconnectedAt: null,
            purgeAfter: null,
            updatedAt: row.now,
          },
        });
    },

    /** Drops the token and starts the retention clock (inboxes_disconnected_dropped_token). */
    async markDisconnected(inboxId: string, now: Date, purgeAfter: Date): Promise<void> {
      await db
        .update(inboxes)
        .set({
          status: 'disconnected',
          tokenCiphertext: null,
          tokenKeyId: null,
          disconnectedAt: now,
          purgeAfter,
          updatedAt: now,
        })
        .where(eq(inboxes.id, inboxId));
    },

    /** The grant was revoked or expired at Google. Scans stop until the user reconnects. */
    async markInboxError(inboxId: string, now: Date): Promise<void> {
      await db.update(inboxes).set({ status: 'error', updatedAt: now }).where(eq(inboxes.id, inboxId));
    },

    async setLastScan(inboxId: string, at: Date): Promise<void> {
      await db.update(inboxes).set({ lastScanAt: at, updatedAt: at }).where(eq(inboxes.id, inboxId));
    },

    /** Inboxes that may still hold a token, for account deletion. */
    async listTokenHolders(userId: string): Promise<InboxRow[]> {
      return db
        .select(inboxColumns)
        .from(inboxes)
        .where(and(eq(inboxes.userId, userId), ne(inboxes.status, 'disconnected')));
    },

    // ---- scans ----

    /** Returns the new scan, or the active one if there already is one (one active scan per inbox). */
    async createScan(inboxId: string): Promise<{ scan: ScanRow; created: boolean }> {
      const inserted = await db
        .insert(scans)
        .values({ id: newId('scan'), inboxId, status: 'queued' })
        .onConflictDoNothing()
        .returning(scanColumns);
      if (inserted[0]) return { scan: inserted[0], created: true };
      const [active] = await db
        .select(scanColumns)
        .from(scans)
        .where(and(eq(scans.inboxId, inboxId), inArray(scans.status, ['queued', 'running'])));
      if (!active) throw new Error('scan insert conflicted but no active scan found');
      return { scan: active, created: false };
    },

    async findScan(scanId: string): Promise<ScanRow | undefined> {
      const [row] = await db.select(scanColumns).from(scans).where(eq(scans.id, scanId));
      return row;
    },

    async latestScan(inboxId: string): Promise<ScanRow | undefined> {
      const [row] = await db
        .select(scanColumns)
        .from(scans)
        .where(eq(scans.inboxId, inboxId))
        .orderBy(desc(scans.createdAt), desc(scans.id))
        .limit(1);
      return row;
    },

    async listActiveScans(): Promise<ScanRow[]> {
      return db.select(scanColumns).from(scans).where(inArray(scans.status, ['queued', 'running']));
    },

    async markScanRunning(scanId: string, now: Date): Promise<void> {
      await db
        .update(scans)
        .set({ status: 'running', startedAt: sql`coalesce(${scans.startedAt}, ${now.toISOString()}::timestamptz)` })
        .where(and(eq(scans.id, scanId), inArray(scans.status, ['queued', 'running'])));
    },

    /** Progress never goes backwards, even if a resumed run re-estimates. */
    async saveScanProgress(scanId: string, p: { cursor: string | null; progressPct: number; foundCount: number }): Promise<void> {
      await db
        .update(scans)
        .set({
          cursor: p.cursor,
          progressPct: sql`greatest(${scans.progressPct}, ${p.progressPct})`,
          foundCount: p.foundCount,
        })
        .where(and(eq(scans.id, scanId), eq(scans.status, 'running')));
    },

    async finishScan(scanId: string, foundCount: number, now: Date): Promise<void> {
      await db
        .update(scans)
        .set({ status: 'done', progressPct: 100, foundCount, finishedAt: now, cursor: null })
        .where(and(eq(scans.id, scanId), eq(scans.status, 'running')));
    },

    async failScan(scanId: string, errorCode: string, now: Date): Promise<void> {
      await db
        .update(scans)
        .set({ status: 'failed', errorCode, finishedAt: now })
        .where(and(eq(scans.id, scanId), inArray(scans.status, ['queued', 'running'])));
    },

    async failActiveScansForInbox(inboxId: string, errorCode: string, now: Date): Promise<void> {
      await db
        .update(scans)
        .set({ status: 'failed', errorCode, finishedAt: now })
        .where(and(eq(scans.inboxId, inboxId), inArray(scans.status, ['queued', 'running'])));
    },

    // ---- detected companies ----

    /**
     * Idempotent: the same detections can be applied any number of times (F2-AC2). Dates widen, signals
     * union, and a company the user marked "not mine" keeps that status (F2-AC3).
     */
    async upsertDetections(userId: string, inboxId: string, detections: Detection[]): Promise<void> {
      if (detections.length === 0) return;
      const companyIds = await resolveCompanies(db, detections.map((d) => d.domain));
      const rows = detections.flatMap((d) => {
        const company = companyIds.get(d.domain);
        return company
          ? [
              {
                id: newId('userCompany'),
                userId,
                companyId: company.id,
                inboxId,
                firstSeen: d.firstSeen,
                lastSeen: d.lastSeen,
                signalTypes: d.signals,
                // A must-keep company (for example the account provider) is flagged so no deletion is offered.
                ...(company.mustKeep ? { riskLevel: 'must_keep' as const } : {}),
              },
            ]
          : [];
      });
      if (rows.length === 0) return;
      await db
        .insert(userCompanies)
        .values(rows)
        .onConflictDoUpdate({
          target: [userCompanies.userId, userCompanies.companyId],
          set: {
            firstSeen: sql`least(${userCompanies.firstSeen}, excluded.first_seen)`,
            lastSeen: sql`greatest(${userCompanies.lastSeen}, excluded.last_seen)`,
            signalTypes: sql`array(select distinct unnest(${userCompanies.signalTypes} || excluded.signal_types) order by 1)`,
            riskLevel: sql`coalesce(excluded.risk_level, ${userCompanies.riskLevel})`,
            updatedAt: sql`now()`,
          },
        });
    },

    /** Detected companies for a user, newest activity first. Company fields and dates only. */
    async listDetections(userId: string): Promise<DetectedCompany[]> {
      return db
        .select({
          company: companies.name,
          domain: sql<string>`${companies.domains}[1]`,
          firstSeen: userCompanies.firstSeen,
          lastSeen: userCompanies.lastSeen,
          signals: userCompanies.signalTypes,
          status: userCompanies.status,
          mustKeep: companies.mustKeep,
          category: companies.category,
        })
        .from(userCompanies)
        .innerJoin(companies, eq(companies.id, userCompanies.companyId))
        .where(eq(userCompanies.userId, userId))
        .orderBy(desc(userCompanies.lastSeen), companies.name);
    },

    async countDetected(userId: string, inboxId: string): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(userCompanies)
        .where(
          and(eq(userCompanies.userId, userId), eq(userCompanies.inboxId, inboxId), ne(userCompanies.status, 'not_mine')),
        );
      return row?.n ?? 0;
    },
  };
}
export type GmailRepository = ReturnType<typeof createGmailRepository>;

/**
 * Maps registrable domains to company ids. A domain the catalog already lists uses that company.
 * Unknown domains get a placeholder company with no grievance contact, which blocks drafting until
 * the owner adds a reviewed catalog entry (docs/OPEN-QUESTIONS.md).
 */
async function resolveCompanies(db: Db, domains: string[]): Promise<Map<string, { id: string; mustKeep: boolean }>> {
  const out = new Map<string, { id: string; mustKeep: boolean }>();
  const known = await db
    .select({ id: companies.id, domains: companies.domains, mustKeep: companies.mustKeep })
    .from(companies)
    .where(arrayOverlaps(companies.domains, domains));
  for (const c of known) for (const d of c.domains) if (domains.includes(d) && !out.has(d)) out.set(d, { id: c.id, mustKeep: c.mustKeep });

  for (const domain of domains) {
    if (out.has(domain)) continue;
    let slug = slugFor(domain);
    for (let attempt = 0; attempt < 2; attempt++) {
      await db
        .insert(companies)
        .values({ id: newId('company'), slug, name: nameFor(domain), domains: [domain], category: 'other' })
        .onConflictDoNothing();
      const [row] = await db
        .select({ id: companies.id, domains: companies.domains, mustKeep: companies.mustKeep })
        .from(companies)
        .where(eq(companies.slug, slug));
      if (row?.domains.includes(domain)) {
        out.set(domain, { id: row.id, mustKeep: row.mustKeep });
        break;
      }
      // The slug belongs to a different domain: disambiguate deterministically.
      slug = `${slugFor(domain)}-${createHash('sha1').update(domain).digest('hex').slice(0, 6)}`;
    }
  }
  return out;
}
