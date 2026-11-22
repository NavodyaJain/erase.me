import { randomBytes } from 'node:crypto';
import { newId } from '../src/common/ids.js';
import type { TestDb } from './db-helper.js';
import { connectInbox, signIn, type Harness, type Session } from './harness.js';

/** Shared setup for integration tests: a signed-in user with a connected inbox, and detected companies to seed. */
export type Contact = 'fictional' | 'real' | 'none' | 'unverified' | 'bounced' | 'form' | 'realform';
export interface SeedOptions {
  name?: string;
  contact?: Contact;
  mustKeep?: boolean;
  signals?: string[];
  status?: 'active' | 'not_mine';
  riskLevel?: 'must_keep';
  /** The company's own account-deletion page. */
  selfServeUrl?: string;
  /** Use this domain instead of a generated one (for example a delivery service that the list hides). */
  domainOverride?: string;
}

export interface Actor {
  s: Session;
  inboxId: string;
  email: string;
  name: string;
  /** Adds a detected company for this user and returns its user_company id and company id. */
  seed(o?: SeedOptions): Promise<{ ucId: string; companyId: string; contactEmail: string | null }>;
}


export function actorFactory(getDb: () => TestDb) {
  const t = {
    get owner() {
      return getDb().owner;
    },
  };
  return async function actor(harness: Harness, label: string): Promise<Actor> {
    const email = `${label}@example.test`;
    const name = `Person ${label}`;
    const s = await signIn(harness, { email, sub: `g-${label}`, name });
    const { inboxId } = await connectInbox(harness, s, { email: `${label}-mail@example.test`, sub: `g-${label}-mail` });
    return {
      s,
      inboxId,
      email,
      name,
      async seed(o = {}) {
        const companyId = newId('company');
        const ucId = newId('userCompany');
        const slug = `co-${randomBytes(5).toString('hex')}`;
        const domain = o.domainOverride ?? `${slug}.example`;
        const contact = o.contact ?? 'fictional';
        const cols = {
          fictional: ['privacy@example.com', 'https://example.com/privacy', '2026-01-01', 'verified', true],
          real: [`grievance@${domain}`, `https://${domain}/privacy`, '2026-01-01', 'verified', false],
          none: [null, null, null, 'unknown', false],
          unverified: [`grievance@${domain}`, `https://${domain}/privacy`, '2026-01-01', 'unknown', false],
          bounced: [`grievance@${domain}`, `https://${domain}/privacy`, '2026-01-01', 'bounced', false],
          form: [null, 'https://example.com/privacy', '2026-01-01', 'verified', true],
          realform: [null, `https://${domain}/privacy`, '2026-01-01', 'verified', false],
        }[contact];
        const formUrl = contact === 'form' ? 'https://example.com/privacy/request' : contact === 'realform' ? `https://${domain}/privacy/request` : null;
        await t.owner.query(
          `INSERT INTO companies (id, slug, name, domains, category, grievance_email, grievance_source, grievance_verified_on, grievance_status, is_fictional, must_keep, grievance_channel, grievance_form_url, self_serve_url)
           VALUES ($1, $2, $3, ARRAY[$4], 'ecommerce', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [companyId, slug, o.name ?? `Shop ${slug.slice(3, 8)}`, domain, ...cols, o.mustKeep ?? false, formUrl ? 'web_form' : 'email', formUrl, o.selfServeUrl ?? null],
        );
        await t.owner.query(
          `INSERT INTO user_companies (id, user_id, company_id, inbox_id, first_seen, last_seen, signal_types, status, risk_level)
           VALUES ($1, $2, $3, $4, now() - interval '90 days', now(), $5, $6, $7)`,
          [ucId, s.userId, companyId, inboxId, o.signals ?? ['welcome', 'receipt'], o.status ?? 'active', o.riskLevel ?? null],
        );
        return { ucId, companyId, contactEmail: cols[0] as string | null };
      },
    };
  }
}
