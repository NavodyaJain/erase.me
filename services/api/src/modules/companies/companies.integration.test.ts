import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createTestDb, type TestDb } from '../../../test/db-helper.js';
import { newId } from '../../common/ids.js';
import type { Db } from '../../db/client.js';
import * as schema from '../../db/schema/index.js';
import { loadCatalog } from './catalog.js';
import { createCompaniesRepository } from './companies.repository.js';

let t: TestDb;
let repo: ReturnType<typeof createCompaniesRepository>;
beforeAll(async () => {
  t = await createTestDb();
  repo = createCompaniesRepository(drizzle(t.app, { schema }) as unknown as Db);
});
afterAll(async () => {
  await t.drop();
});

const row = async (domain: string) =>
  (
    await t.owner.query<{ name: string; must_keep: boolean; category: string; grievance_email: string | null; is_fictional: boolean; domains: string[] }>(
      'SELECT name, must_keep, category, grievance_email, is_fictional, domains FROM companies WHERE $1 = ANY(domains)',
      [domain],
    )
  ).rows;

describe('syncCatalog', () => {
  const catalog = loadCatalog({ includeFictional: true });

  it('inserts catalog companies with proper names, the must-keep flag and no invented contact', async () => {
    const result = await repo.syncCatalog(catalog);
    expect(result.inserted).toBe(catalog.length);
    expect(await row('google.com')).toEqual([expect.objectContaining({ name: 'Google', must_keep: true, grievance_email: null })]);
    expect(await row('happnmail.com')).toEqual([expect.objectContaining({ name: 'Happn', must_keep: false })]);
  });

  it('stores a fictional contact only for fictional entries, on @example.com', async () => {
    const [bank] = await row('samplebank.example');
    expect(bank).toMatchObject({ is_fictional: true, grievance_email: 'privacy@example.com' });
  });

  it('is idempotent', async () => {
    const again = await repo.syncCatalog(catalog);
    expect(again).toEqual({ inserted: 0, updated: catalog.length });
    const { rows } = await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM companies');
    expect(rows[0]?.n).toBe(String(catalog.length));
  });

  it('renames a placeholder the scan created from a bare domain, in place (item 2)', async () => {
    await t.owner.query(
      `INSERT INTO companies (id, slug, name, domains, category) VALUES ($1, 'newbrand-example', 'Newbrand', ARRAY['newbrand.example'], 'other')`,
      [newId('company')],
    );
    await repo.syncCatalog([{ slug: 'new-brand', name: 'New Brand', domains: ['newbrand.example', 'newbrand-mail.example'], category: 'saas', must_keep: false, fictional: false }]);
    const rows = await row('newbrand.example');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'New Brand', category: 'saas' });
    expect(rows[0]?.domains).toEqual(expect.arrayContaining(['newbrand.example', 'newbrand-mail.example']));
  });
});
