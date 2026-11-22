import { and, arrayOverlaps, eq, sql } from 'drizzle-orm';
import { newId } from '../../common/ids.js';
import type { Db } from '../../db/client.js';
import { companies, requests, userCompanies } from '../../db/schema/index.js';
import type { CatalogEntry } from './catalog.js';

/** The only code that writes the canonical company records from the catalog. */
export function createCompaniesRepository(db: Db) {
  return {
    /** One detected company of this user, with what the keep rules need. Ownership is part of the query. */
    async findUserCompany(userId: string, userCompanyId: string) {
      const [row] = await db
        .select({
          id: userCompanies.id,
          status: userCompanies.status,
          riskLevel: userCompanies.riskLevel,
          keptAt: userCompanies.keptAt,
          mustKeep: companies.mustKeep,
        })
        .from(userCompanies)
        .innerJoin(companies, eq(companies.id, userCompanies.companyId))
        .where(and(eq(userCompanies.id, userCompanyId), eq(userCompanies.userId, userId)));
      return row;
    },

    /** Sets or clears "keep". Idempotent: setting it again keeps the original time. */
    async setKept(userId: string, userCompanyId: string, kept: boolean): Promise<void> {
      await db
        .update(userCompanies)
        .set({ keptAt: kept ? sql`coalesce(${userCompanies.keptAt}, now())` : null, updatedAt: sql`now()` })
        .where(and(eq(userCompanies.id, userCompanyId), eq(userCompanies.userId, userId)));
    },

    /** The open request (not closed or bounced) of each of the user's detected companies. */
    async openRequests(userId: string): Promise<Map<string, { id: string; status: string }>> {
      const rows = await db
        .select({ userCompanyId: requests.userCompanyId, id: requests.id, status: requests.status })
        .from(requests)
        .where(and(eq(requests.userId, userId), sql`${requests.status} not in ('closed', 'bounced')`));
      return new Map(rows.map((r) => [r.userCompanyId, { id: r.id, status: r.status }]));
    },

    /**
     * Makes the companies table match the catalog: the display name, category, domains and must-keep flag.
     * A company the scan already created from a bare domain is updated in place (matched by domain), so a
     * placeholder name becomes the proper one. Idempotent. A grievance contact (an address or a web form) is
     * written only when the catalog entry has one, with its source and verification date. The self-serve link
     * follows the catalog on every sync.
     */
    async syncCatalog(entries: CatalogEntry[]): Promise<{ inserted: number; updated: number }> {
      let inserted = 0;
      let updated = 0;
      for (const e of entries) {
        const g = e.grievance;
        // Both fields are always written together, so a switch of channel never leaves the old one behind.
        const contact = g
          ? {
              grievanceChannel: g.channel,
              grievanceEmail: g.channel === 'email' ? g.email : null,
              grievanceFormUrl: g.channel === 'web_form' ? g.form_url : null,
              grievanceSource: g.source_url,
              grievanceVerifiedOn: g.verified_on,
              grievanceStatus: 'verified' as const,
            }
          : {};
        const selfServe = { selfServeUrl: e.self_serve_url ?? null };
        const [existing] = await db
          .select({ id: companies.id, domains: companies.domains })
          .from(companies)
          .where(arrayOverlaps(companies.domains, e.domains))
          .orderBy(companies.createdAt)
          .limit(1);
        if (existing) {
          const merged = [...new Set([...existing.domains, ...e.domains])];
          await db
            .update(companies)
            .set({
              name: e.name,
              category: e.category,
              mustKeep: e.must_keep,
              isFictional: e.fictional,
              domains: merged,
              ...contact,
              ...selfServe,
              updatedAt: sql`now()`,
            })
            .where(eq(companies.id, existing.id));
          updated += 1;
          continue;
        }
        const res = await db
          .insert(companies)
          .values({
            id: newId('company'),
            slug: e.slug,
            name: e.name,
            domains: e.domains,
            category: e.category,
            mustKeep: e.must_keep,
            isFictional: e.fictional,
            ...contact,
            ...selfServe,
          })
          .onConflictDoUpdate({
            target: companies.slug,
            set: { name: e.name, category: e.category, mustKeep: e.must_keep, domains: e.domains, ...selfServe, updatedAt: sql`now()` },
            setWhere: and(eq(companies.slug, e.slug)),
          })
          .returning({ id: companies.id });
        inserted += res.length;
      }
      return { inserted, updated };
    },
  };
}
export type CompaniesRepository = ReturnType<typeof createCompaniesRepository>;
