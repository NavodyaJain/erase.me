import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { inboxes, users } from './accounts.js';
import { companyCategory, grievanceStatus, riskLevel, userCompanyStatus } from './enums.js';
import { createdAt, emptyTextArray, idCheck, ts, updatedAt } from './_shared.js';

const EXAMPLE_ADDRESS = sql.raw(`'@example\\.com$'`);

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
    // Unknown contact blocks the draft; a known contact must say where it came from and when it was checked.
    check(
      'companies_grievance_provenance',
      sql`${t.grievanceEmail} IS NULL OR (${t.grievanceSource} IS NOT NULL AND ${t.grievanceVerifiedOn} IS NOT NULL)`,
    ),
    check('companies_verified_has_email', sql`${t.grievanceStatus} <> 'verified' OR ${t.grievanceEmail} IS NOT NULL`),
    check(
      'companies_fictional_example_only',
      sql`NOT ${t.isFictional} OR ${t.grievanceEmail} IS NULL OR ${t.grievanceEmail} ~* ${EXAMPLE_ADDRESS}`,
    ),
    check(
      'companies_real_not_example',
      sql`${t.isFictional} OR ${t.grievanceEmail} IS NULL OR ${t.grievanceEmail} !~* ${EXAMPLE_ADDRESS}`,
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
