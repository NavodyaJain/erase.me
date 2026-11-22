// Development only (excluded from the production build with the rest of src/dev).
// `pnpm --filter @erase/api dev:coverage` reports how much of the connected inbox the scan can see:
// message COUNTS for a few Gmail searches, so you can tell whether a message cap, a date window or the
// search itself is why companies are missing. It lists message ids only and never reads any message content.
import { createDb } from '../db/client.js';
import { LocalKeyProvider } from '../crypto/key-provider.js';
import { TokenVault } from '../crypto/token-vault.js';
import { googleRedirectUri, loadEnv } from '../config/env.js';
import { createAuditRepository } from '../modules/audit/audit.repository.js';
import { HttpGoogleOAuthClient } from '../modules/auth/google-oauth.js';
import { HttpGmailClient } from '../modules/gmail/gmail.client.js';
import { createGmailRepository } from '../modules/gmail/gmail.repository.js';
import { InboxService } from '../modules/gmail/inbox.service.js';
import { buildScanQuery, scanOptionsFromEnv, SCAN_QUERY } from '../modules/gmail/scan.service.js';
import { assertDevHelperAllowed } from './dev-helper.js';

const env = loadEnv();
assertDevHelperAllowed(env);
if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.TOKEN_MASTER_KEY) {
  process.stderr.write('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_MASTER_KEY must be set in .env.\n');
  process.exit(1);
}

const { db, pool, close } = createDb(env.DATABASE_URL);
const repo = createGmailRepository(db);
const inboxes = new InboxService(
  repo,
  new TokenVault(new LocalKeyProvider(env.TOKEN_MASTER_KEY)),
  new HttpGoogleOAuthClient({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: googleRedirectUri(env) }),
  createAuditRepository(db),
);
// Same pace as the scan.
const gmail = new HttpGmailClient({ maxRequestsPerSecond: 10 });
const CAP = 5000;

async function count(token: string, query: string): Promise<string> {
  let n = 0;
  let pageToken: string | undefined;
  do {
    const page = await gmail.listMessageIds(token, { query, maxResults: 100, ...(pageToken ? { pageToken } : {}) });
    n += page.ids.length;
    pageToken = page.nextPageToken;
  } while (pageToken && n < CAP);
  return pageToken ? `${n}+ (stopped counting at ${CAP})` : String(n);
}

try {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM inboxes WHERE status = 'connected' ORDER BY connected_at DESC LIMIT 1");
  const inbox = rows[0] ? await repo.findInbox(rows[0].id) : undefined;
  if (!inbox) {
    process.stderr.write('No connected inbox. Connect one at http://localhost:4000/dev/connect first.\n');
    process.exit(1);
  }
  const token = await inboxes.accessTokenFor(inbox);
  const profile = (await (
    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { messagesTotal?: number };
  const opts = scanOptionsFromEnv(env);
  process.stdout.write(`Settings: SCAN_WINDOW_YEARS=${opts.windowYears ?? 'none (whole mailbox)'}, SCAN_MAX_MESSAGES=${opts.maxMessages}\n`);
  process.stdout.write(`Mailbox size (messages): ${profile.messagesTotal ?? 'unknown'}\n\n`);

  const scanQuery = buildScanQuery(opts.windowYears, new Date());
  const rowsOut: Array<[string, string]> = [
    ['Matched by the scan query (what a scan reads)', await count(token, scanQuery)],
    ['Whole mailbox, any mail', await count(token, 'in:anywhere -in:spam -in:trash')],
    ['Mail in the last 2 years', await count(token, 'newer_than:2y')],
    ['Mail older than 2 years', await count(token, 'older_than:2y')],
    ['Mail older than 1 year', await count(token, 'older_than:1y')],
    ['Primary tab, not matched by the scan query', await count(token, `category:primary -(${SCAN_QUERY})`)],
    ['Subject mentions statement or transaction', await count(token, 'subject:(statement OR transaction)')],
    ['Subject mentions order, shipped or booking', await count(token, 'subject:(order OR shipped OR booking)')],
  ];
  for (const [label, value] of rowsOut) process.stdout.write(`${label.padEnd(50)} ${value}\n`);
  process.stdout.write(
    `\nIf "Matched by the scan query" is below SCAN_MAX_MESSAGES and no window is set, neither a cap nor a date window cut the scan.\n`,
  );
} finally {
  await close();
}
