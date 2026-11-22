import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { COMPANY_CATEGORIES } from '../../db/schema/enums.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** services/api/catalog, reached from both src/modules/companies and dist/modules/companies. */
export const CATALOG_DIR = path.resolve(here, '../../../catalog');

const DOMAIN = /^[a-z0-9]+([.-][a-z0-9]+)*\.[a-z]{2,}$/;

const Grievance = z.object({
  email: z.string().email(),
  /** The company's published privacy or grievance page. */
  source_url: z.string().url(),
  /** When a person last checked the contact against that page. */
  verified_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const Entry = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    name: z.string().min(1).max(80),
    domains: z.array(z.string().regex(DOMAIN)).min(1),
    category: z.enum(COMPANY_CATEGORIES),
    /** Needed to keep the account or service working. No deletion request is offered for these. */
    must_keep: z.boolean().default(false),
    fictional: z.boolean().default(false),
    note: z.string().optional(),
    grievance: Grievance.optional(),
  })
  .superRefine((e, ctx) => {
    const example = e.grievance && /@example\.com$/i.test(e.grievance.email);
    if (e.fictional && e.grievance && !example) {
      ctx.addIssue({ code: 'custom', path: ['grievance', 'email'], message: 'fictional entries may only use @example.com' });
    }
    if (!e.fictional && example) {
      ctx.addIssue({ code: 'custom', path: ['grievance', 'email'], message: '@example.com is for fictional entries only' });
    }
    if (e.must_keep && e.grievance) {
      ctx.addIssue({ code: 'custom', path: ['grievance'], message: 'a must-keep company gets no grievance contact (no deletion request is offered)' });
    }
  });

const CatalogFile = z.object({ version: z.literal(1), companies: z.array(Entry) }).passthrough();

export type CatalogEntry = z.infer<typeof Entry>;

/** Parses and validates a catalog file's text. Throws with the paths of invalid fields, never their values. */
export function parseCatalog(text: string, label: string): CatalogEntry[] {
  const parsed = CatalogFile.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid catalog ${label}: ${where}`);
  }
  return parsed.data.companies;
}

export interface LoadCatalogOptions {
  dir?: string;
  /** Fictional development entries are loaded outside production only. */
  includeFictional: boolean;
}

/**
 * catalog.json (reviewed, committed) plus catalog.local.json (the owner's own additions, not committed).
 * A local entry overrides a committed one with the same slug.
 */
export function loadCatalog(opts: LoadCatalogOptions): CatalogEntry[] {
  const dir = opts.dir ?? CATALOG_DIR;
  const bySlug = new Map<string, CatalogEntry>();
  for (const file of ['catalog.json', 'catalog.local.json']) {
    let text: string;
    try {
      text = readFileSync(path.join(dir, file), 'utf8');
    } catch (err) {
      if (file === 'catalog.local.json' && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const e of parseCatalog(text, file)) bySlug.set(e.slug, e);
  }
  const all = [...bySlug.values()];
  const domainOwner = new Map<string, string>();
  for (const e of all) {
    for (const d of e.domains) {
      const other = domainOwner.get(d);
      if (other && other !== e.slug) throw new Error(`Invalid catalog: domain claimed by two entries (${other}, ${e.slug})`);
      domainOwner.set(d, e.slug);
    }
  }
  return opts.includeFictional ? all : all.filter((e) => !e.fictional);
}
