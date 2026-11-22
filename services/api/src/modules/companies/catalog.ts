import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { COMPANY_CATEGORIES } from '../../db/schema/enums.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** services/api/catalog, reached from both src/modules/companies and dist/modules/companies. */
export const CATALOG_DIR = path.resolve(here, '../../../catalog');

const DOMAIN = /^[a-z0-9]+([.-][a-z0-9]+)*\.[a-z]{2,}$/;

const httpsUrl = z
  .string()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !/\s/.test(v);
    } catch {
      return false;
    }
  }, 'must be an https URL');

const provenance = {
  /** The company's published privacy or grievance page the contact came from. */
  source_url: httpsUrl,
  /** When a person last checked the contact against that page. */
  verified_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

/** A grievance address. The default channel, so existing entries need no `channel`. */
const EmailContact = z.object({ channel: z.literal('email').default('email'), email: z.string().email(), ...provenance }).strict();
/** A web form: it cannot be sent by email, so requests show the draft for copy and paste and link to the form. */
const FormContact = z.object({ channel: z.literal('web_form'), form_url: httpsUrl, ...provenance }).strict();
const Grievance = z.union([FormContact, EmailContact]);

const isExampleHost = (url: string): boolean => /^https:\/\/([a-z0-9-]+\.)*example\.com(\/|$)/i.test(url);

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
    /** The company's own account-deletion page, shown before a request by email. Optional. */
    self_serve_url: httpsUrl.optional(),
    grievance: Grievance.optional(),
  })
  .superRefine((e, ctx) => {
    const issue = (p: string[], message: string) => ctx.addIssue({ code: 'custom', path: p, message });
    const g = e.grievance;
    const address = g?.channel === 'email' ? g.email : undefined;
    const form = g?.channel === 'web_form' ? g.form_url : undefined;

    if (e.fictional) {
      if (address && !/@example\.com$/i.test(address)) issue(['grievance', 'email'], 'fictional entries may only use @example.com');
      if (form && !isExampleHost(form)) issue(['grievance', 'form_url'], 'fictional entries may only use a form on example.com');
      if (e.self_serve_url && !isExampleHost(e.self_serve_url)) issue(['self_serve_url'], 'fictional entries may only use a URL on example.com');
    } else {
      if (address && /@example\.com$/i.test(address)) issue(['grievance', 'email'], '@example.com is for fictional entries only');
      if (form && isExampleHost(form)) issue(['grievance', 'form_url'], 'example.com is for fictional entries only');
      if (e.self_serve_url && isExampleHost(e.self_serve_url)) issue(['self_serve_url'], 'example.com is for fictional entries only');
    }
    if (e.must_keep && g) issue(['grievance'], 'a must-keep company gets no grievance contact (no deletion request is offered)');
    if (e.must_keep && e.self_serve_url) issue(['self_serve_url'], 'a must-keep company gets no self-serve deletion link (no deletion is offered)');
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
