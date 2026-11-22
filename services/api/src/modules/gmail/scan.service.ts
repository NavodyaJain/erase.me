import { Problems } from '../../common/errors.js';
import type { JobQueue } from '../../jobs/queue.js';
import { GmailApiError, type GmailClient } from './gmail.client.js';
import type { GmailRepository, ScanRow } from './gmail.repository.js';
import type { InboxService } from './inbox.service.js';
import { ExcludeList, parseExcludeList } from './detection-rules.js';
import { aggregate, readSighting, registrableDomain, type Sighting } from './signals.js';

export const SCAN_JOB = 'scan-inbox';

/**
 * Targeted search for account, receipt and statement mail (TRD 6.6). Gmail evaluates it server-side; we only
 * ever read header metadata of the matches. Beyond the Updates and Promotions tabs it covers mail Gmail files
 * as purchases or reservations, and subjects that read like orders, payments, statements and bookings, which
 * banks and shops often send to the Primary tab.
 */
export const SCAN_QUERY =
  'category:updates OR category:promotions OR category:purchases OR category:reservations OR subject:(welcome OR receipt OR invoice OR statement OR transaction OR payment OR order OR shipped OR delivered OR booking OR ticket OR "verify your" OR "confirm your")';

const PAGE_SIZE = 100;
const FETCH_CONCURRENCY = 5; // keeps us well inside per-user Gmail quota; request pacing lives in the client

export interface ScanOptions {
  /** Years of mail to scan, counted back from the day the scan was created. Undefined: the whole mailbox. */
  windowYears?: number | undefined;
  /** Stop after this many matching messages. */
  maxMessages: number;
  /** SCAN_EXCLUDE entries: domains or full addresses to leave out. */
  exclude: string[];
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = { maxMessages: 50_000, exclude: [] };

export function scanOptionsFromEnv(env: { SCAN_WINDOW_YEARS?: number | undefined; SCAN_MAX_MESSAGES: number; SCAN_EXCLUDE?: string | undefined }): ScanOptions {
  return { windowYears: env.SCAN_WINDOW_YEARS, maxMessages: env.SCAN_MAX_MESSAGES, exclude: parseExcludeList(env.SCAN_EXCLUDE) };
}

/**
 * The Gmail search for one scan. The window starts from the day the scan was created, not from today, so a
 * scan resumed on a later day keeps the same query and its saved page token stays valid.
 */
export function buildScanQuery(windowYears: number | undefined, scanCreatedAt: Date): string {
  if (!windowYears) return `(${SCAN_QUERY})`;
  const from = new Date(Date.UTC(scanCreatedAt.getUTCFullYear() - windowYears, scanCreatedAt.getUTCMonth(), scanCreatedAt.getUTCDate()));
  const ymd = `${from.getUTCFullYear()}/${String(from.getUTCMonth() + 1).padStart(2, '0')}/${String(from.getUTCDate()).padStart(2, '0')}`;
  return `(${SCAN_QUERY}) after:${ymd}`;
}

export interface ScanView {
  id: string;
  inboxId: string;
  status: ScanRow['status'];
  progressPct: number;
  foundCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
}

const view = (s: ScanRow): ScanView => ({
  id: s.id,
  inboxId: s.inboxId,
  status: s.status,
  progressPct: s.progressPct,
  foundCount: s.foundCount,
  startedAt: s.startedAt,
  finishedAt: s.finishedAt,
  errorCode: s.errorCode,
});

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class ScanService {
  constructor(
    private readonly repo: GmailRepository,
    private readonly inboxes: InboxService,
    private readonly gmail: GmailClient,
    private readonly queue: JobQueue,
    private readonly now: () => Date = () => new Date(),
    private readonly log: { info(o: object, m: string): void; warn(o: object, m: string): void } = {
      info: () => undefined,
      warn: () => undefined,
    },
    private readonly opts: ScanOptions = DEFAULT_SCAN_OPTIONS,
  ) {}

  /** Idempotent: a second start while one is active returns the active scan (F2-AC2). */
  async start(userId: string, inboxId: string): Promise<{ scan: ScanView; created: boolean }> {
    const inbox = await this.repo.findOwnedInbox(userId, inboxId);
    if (!inbox) throw Problems.notFound();
    if (inbox.status !== 'connected') {
      throw Problems.conflict('inbox_not_connected', 'Inbox is not connected', 'Reconnect this inbox to scan it.');
    }
    const { scan, created } = await this.repo.createScan(inbox.id);
    if (created) this.queue.enqueue(SCAN_JOB, { scanId: scan.id });
    return { scan: view(scan), created };
  }

  async latest(userId: string, inboxId: string): Promise<ScanView> {
    const inbox = await this.repo.findOwnedInbox(userId, inboxId);
    if (!inbox) throw Problems.notFound();
    const scan = await this.repo.latestScan(inbox.id);
    if (!scan) throw Problems.notFound();
    return view(scan);
  }

  /** Re-queues scans that were queued or running when the process stopped. They resume from their cursor. */
  async resumeInterrupted(): Promise<number> {
    const active = await this.repo.listActiveScans();
    for (const s of active) this.queue.enqueue(SCAN_JOB, { scanId: s.id });
    return active.length;
  }

  /**
   * The scan job. Resumable (the Gmail page token is saved after each page) and idempotent (detections are
   * merged, never duplicated). Counts only in logs: no addresses, domains, subjects or message ids.
   */
  async run(scanId: string): Promise<void> {
    const scan = await this.repo.findScan(scanId);
    if (!scan || (scan.status !== 'queued' && scan.status !== 'running')) return;
    const inbox = await this.repo.findInbox(scan.inboxId);
    if (!inbox || inbox.status !== 'connected') {
      await this.repo.failScan(scan.id, 'inbox_disconnected', this.now());
      return;
    }
    await this.repo.markScanRunning(scan.id, this.now());

    try {
      let cursor: string | undefined = scan.cursor ?? undefined;
      let scanned = 0;
      let skipped = 0; // deleted since listing, or no usable date
      let estimate: number | undefined;
      let ignored = 0; // not a company signal: a person, a code, an excluded or unattributable sender
      let hitCap = false;
      let found = await this.repo.countDetected(inbox.userId, inbox.id);
      const exclude = new ExcludeList(this.opts.exclude, await this.repo.listOwnAddresses(inbox.userId), registrableDomain);
      const query = buildScanQuery(this.opts.windowYears, scan.createdAt);

      do {
        // Re-read every page: a disconnect during the scan must stop further Gmail calls (F1-AC3).
        const current = await this.repo.findInbox(inbox.id);
        if (!current || current.status !== 'connected') {
          await this.repo.failScan(scan.id, 'inbox_disconnected', this.now());
          return;
        }
        const accessToken = await this.inboxes.accessTokenFor(current);
        const page = await this.gmail.listMessageIds(accessToken, {
          query,
          maxResults: PAGE_SIZE,
          ...(cursor ? { pageToken: cursor } : {}),
        });
        estimate ??= page.estimatedTotal;

        const metas = await mapLimit(page.ids, FETCH_CONCURRENCY, (id) => this.gmail.getMessageMetadata(accessToken, id));
        skipped += metas.filter((m) => m === null).length;
        const sightings = metas.flatMap((m) => {
          const s = m ? readSighting(m, exclude) : null;
          if (m && !s) ignored += 1;
          return s ? [s] : [];
        });
        await this.repo.upsertDetections(inbox.userId, inbox.id, toDetections(sightings));

        scanned += page.ids.length;
        cursor = page.nextPageToken;
        found = await this.repo.countDetected(inbox.userId, inbox.id);
        // Gmail gives only a rough total, so progress is capped below 100 until the scan really finishes.
        const pct = cursor && estimate && estimate > 0 ? Math.min(99, Math.floor((scanned / estimate) * 100)) : 0;
        await this.repo.saveScanProgress(scan.id, { cursor: cursor ?? null, progressPct: pct, foundCount: found });
        if (cursor && scanned >= this.opts.maxMessages) {
          hitCap = true;
          break;
        }
      } while (cursor);

      const now = this.now();
      await this.repo.finishScan(scan.id, found, now);
      await this.repo.setLastScan(inbox.id, now);
      // hitCap means mail beyond SCAN_MAX_MESSAGES was not read; windowYears shows whether a date window applied.
      this.log.info({ scanned, skipped, ignored, found, hitCap, windowYears: this.opts.windowYears ?? null }, 'scan finished');
    } catch (err) {
      const code = err instanceof GmailApiError ? `gmail_${err.code}` : 'internal_error';
      await this.repo.failScan(scan.id, code, this.now());
      // Which call failed, the HTTP status and Google's reason and status only: no tokens, subjects or addresses.
      const f = err instanceof GmailApiError ? err.failure : undefined;
      this.log.warn(
        {
          errorCode: code,
          ...(f
            ? {
                failedCall: f.call,
                httpStatus: f.httpStatus,
                googleReason: f.reason,
                googleStatus: f.googleStatus,
                cause: f.cause,
              }
            : {}),
        },
        'scan failed',
      );
      if (!(err instanceof GmailApiError)) throw err;
    }
  }
}

function toDetections(sightings: Sighting[]) {
  return [...aggregate(sightings)].map(([domain, a]) => ({
    domain,
    firstSeen: a.firstSeen,
    lastSeen: a.lastSeen,
    signals: [...a.signals].sort(),
  }));
}
