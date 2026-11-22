import { and, arrayOverlaps, eq, sql } from 'drizzle-orm';
import { newId } from '../../common/ids.js';
import type { Db } from '../../db/client.js';
import { companies } from '../../db/schema/index.js';
import type { CatalogEntry } from './catalog.js';

/** The only code that writes the canonical company records from the catalog. */
export function createCompaniesRepository(db: Db) {
  return {
    /**
     * Makes the companies table match the catalog: the display name, category, domains and must-keep flag.
     * A company the scan already created from a bare domain is updated in place (matched by domain), so a
     * placeholder name becomes the proper one. Idempotent. A grievance contact is written only when the
     * catalog entry has one, with its source and verification date.
     */
    async syncCatalog(entries: CatalogEntry[]): Promise<{ inserted: number; updated: number }> {
      let inserted = 0;
      let updated = 0;
      for (const e of entries) {
        const contact = e.grievance
          ? {
              grievanceEmail: e.grievance.email,
              grievanceSource: e.grievance.source_url,
              grievanceVerifiedOn: e.grievance.verified_on,
              grievanceStatus: 'verified' as const,
            }
          : {};
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
          })
          .onConflictDoUpdate({
            target: companies.slug,
            set: { name: e.name, category: e.category, mustKeep: e.must_keep, domains: e.domains, updatedAt: sql`now()` },
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
