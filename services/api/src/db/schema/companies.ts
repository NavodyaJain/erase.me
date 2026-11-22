import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { inboxes, users } from './accounts.js';
import { companyCategory, grievanceStatus, riskLevel, userCompanyStatus } from './enums.js';
import { createdAt, emptyTextArray, idCheck, ts, updatedAt } from './_shared.js';

const EXAMPLE_ADDRESS = sql.raw(`'@example\\.com$'`);
/** A URL on example.com or one of its subdomains: the only place fictional entries may point. */
const EXAMPLE_URL = sql.raw(`'^https://([a-z0-9-]+\\.)*example\\.com(/|$)'`);
export const GRIEVANCE_CHANNELS = ['email', 'web_form'] as const;

/**
 * Canonical company record (F2). The grievance contact comes only from the reviewed catalog:
 * every address needs a source page and a verification date, and fictional development entries
 * are limited to @example.com so a made-up address can never be mistaken for a real one.
 */
export const companies = pgTable(
  'companies',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    domains: text('domains').array().notNull().default(emptyTextArray),
    category: companyCategory('category').notNull().default('other'),
    grievanceEmail: text('grievance_email'),
    /** The company's published privacy or grievance page (catalog `source_url`). */
    grievanceSource: text('grievance_source'),
    /** When a person last checked the contact against its source (catalog `verified_on`). */
    grievanceVerifiedOn: date('grievance_verified_on', { mode: 'string' }),
    grievanceStatus: grievanceStatus('grievance_status').notNull().default('unknown'),
    /**
     * How the company takes requests: `email` (grievance_email) or `web_form` (grievance_form_url). A web form
     * cannot be sent by email: the request shows the draft for copy and paste and links to the form.
     */
    grievanceChannel: text('grievance_channel').notNull().default('email'),
    grievanceFormUrl: text('grievance_form_url'),
    /** The company's own account-deletion page, shown to the user before a request by email. Optional. */
    selfServeUrl: text('self_serve_url'),
    /** Catalog `fictional: true`. Development data only. */
    isFictional: boolean('is_fictional').notNull().default(false),
    cancelUrl: text('cancel_url'),
    mustKeep: boolean('must_keep').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('companies_slug_key').on(t.slug),
    index('companies_domains_gin').using('gin', t.domains),
    index('companies_category_idx').on(t.category),
    idCheck(t, 'companies', 'cmp'),
    check('companies_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('companies_grievance_email_format', sql`${t.grievanceEmail} IS NULL OR ${t.grievanceEmail} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`),
    // Unknown contact blocks the draft; a known contact (an address or a form) must say where it came from and when it was checked.
    check(
      'companies_grievance_provenance',
      sql`(${t.grievanceEmail} IS NULL AND ${t.grievanceFormUrl} IS NULL) OR (${t.grievanceSource} IS NOT NULL AND ${t.grievanceVerifiedOn} IS NOT NULL)`,
    ),
    check('companies_channel_valid', sql`${t.grievanceChannel} in ('email', 'web_form')`),
    // One channel at a time: an email contact has no form URL, a web form has no email address.
    check(
      'companies_channel_fields',
      sql`(${t.grievanceChannel} = 'email' AND ${t.grievanceFormUrl} IS NULL) OR (${t.grievanceChannel} = 'web_form' AND ${t.grievanceEmail} IS NULL)`,
    ),
    check(
      'companies_verified_has_contact',
      sql`${t.grievanceStatus} <> 'verified' OR (${t.grievanceChannel} = 'email' AND ${t.grievanceEmail} IS NOT NULL) OR (${t.grievanceChannel} = 'web_form' AND ${t.grievanceFormUrl} IS NOT NULL)`,
    ),
    check('companies_urls_https', sql`(${t.grievanceFormUrl} IS NULL OR ${t.grievanceFormUrl} ~ '^https://[^[:space:]]+$') AND (${t.selfServeUrl} IS NULL OR ${t.selfServeUrl} ~ '^https://[^[:space:]]+$')`),
    // Fictional entries point only at example.com; real ones never do.
    check(
      'companies_fictional_example_only',
      sql`NOT ${t.isFictional} OR ((${t.grievanceEmail} IS NULL OR ${t.grievanceEmail} ~* ${EXAMPLE_ADDRESS}) AND (${t.grievanceFormUrl} IS NULL OR ${t.grievanceFormUrl} ~* ${EXAMPLE_URL}) AND (${t.selfServeUrl} IS NULL OR ${t.selfServeUrl} ~* ${EXAMPLE_URL}))`,
    ),
    check(
      'companies_real_not_example',
      sql`${t.isFictional} OR ((${t.grievanceEmail} IS NULL OR ${t.grievanceEmail} !~* ${EXAMPLE_ADDRESS}) AND (${t.grievanceFormUrl} IS NULL OR ${t.grievanceFormUrl} !~* ${EXAMPLE_URL}) AND (${t.selfServeUrl} IS NULL OR ${t.selfServeUrl} !~* ${EXAMPLE_URL}))`,
    ),
  ],
);

/**
 * A company found in a user's inbox (F2). Only metadata and minimal signals are kept:
 * no email bodies, no subject lines, no sender display names (PRD F2-AC4, section 8).
 */
export const userCompanies = pgTable(
  'user_companies',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    inboxId: text('inbox_id').notNull(),
    firstSeen: ts('first_seen').notNull(),
    lastSeen: ts('last_seen').notNull(),
    signalTypes: text('signal_types').array().notNull().default(emptyTextArray),
    riskLevel: riskLevel('risk_level'),
    holdsHint: text('holds_hint').array().notNull().default(emptyTextArray),
    status: userCompanyStatus('status').notNull().default('active'),
    /** Set when the user chose "keep" for this company: no request is offered or approved for it until cleared. */
    keptAt: ts('kept_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('user_companies_user_company_key').on(t.userId, t.companyId),
    // Target for requests' composite foreign key, so a request can only use its own user's company.
    unique('user_companies_id_user_key').on(t.id, t.userId),
    // The inbox must belong to the same user.
    foreignKey({
      name: 'user_companies_inbox_owner_fk',
      columns: [t.inboxId, t.userId],
      foreignColumns: [inboxes.id, inboxes.userId],
    }),
    index('user_companies_user_id_idx').on(t.userId),
    index('user_companies_company_id_idx').on(t.companyId),
    index('user_companies_inbox_id_idx').on(t.inboxId),
    idCheck(t, 'user_companies', 'ucm'),
    check('user_companies_seen_order', sql`${t.lastSeen} >= ${t.firstSeen}`),
  ],
);
