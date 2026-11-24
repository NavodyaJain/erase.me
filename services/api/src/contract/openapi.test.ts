import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { ajv, problemSchemaFor, spec, specText, validateAgainst, type Json } from '../../test/contract.js';
import { readCommitted } from './files.js';
import { buildOpenApi, serializeOpenApi } from './openapi.js';
import { operations } from './routes.js';
import { BLOCKER_CODES, PROBLEM_CODES } from './schemas.js';

const text = specText;

const methods = ['get', 'put', 'post', 'patch', 'delete'] as const;
const allOperations = (): Array<{ path: string; method: string; op: Json }> =>
  Object.entries(spec.paths as Json).flatMap(([p, item]) => methods.filter((m) => item[m]).map((m) => ({ path: p, method: m, op: item[m] as Json })));

describe('the generated OpenAPI document', () => {
  it('is valid OpenAPI 3.1', async () => {
    const validator = new Validator();
    const result = await validator.validate(JSON.parse(text) as Parameters<Validator['validate']>[0]);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(validator.version).toBe('3.1');
    expect(spec.openapi).toBe('3.1.0');
  });

  it('is the committed file, byte for byte (run `pnpm --filter @erase/api openapi:generate` after a contract change)', () => {
    expect(readCommitted()).toBe(text);
  });

  it('is deterministic', () => {
    expect(serializeOpenApi(buildOpenApi())).toBe(text);
  });

  it('documents every operation once, with a unique id, a tag, a summary and at least one response', () => {
    const ops = allOperations();
    expect(ops).toHaveLength(operations.length);
    const ids = ops.map((o) => o.op.operationId as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path: p, method, op } of ops) {
      expect(p, p).toMatch(/^\/v1\//);
      expect(op.tags, `${method} ${p}`).toHaveLength(1);
      expect(op.summary, `${method} ${p}`).toBeTruthy();
      expect(Object.keys(op.responses).length, `${method} ${p}`).toBeGreaterThan(0);
    }
  });

  it('resolves every $ref', () => {
    const missing: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === '$ref' && typeof v === 'string') {
            const name = v.replace('#/components/schemas/', '');
            if (!spec.components.schemas[name]) missing.push(v);
          } else walk(v);
        }
      }
    };
    walk(spec);
    expect(missing).toEqual([]);
  });

  it('requires the session cookie, and the CSRF token on every state-changing call', () => {
    for (const { path: p, method, op } of allOperations()) {
      const needsSession = !p.startsWith('/v1/auth/google/');
      const schemes = (op.security as Array<Record<string, unknown>>).flatMap((s) => Object.keys(s));
      if (!needsSession) {
        expect(schemes, `${method} ${p}`).toEqual([]);
        continue;
      }
      expect(schemes, `${method} ${p}`).toContain('sessionCookie');
      if (method === 'get') expect(schemes, `${method} ${p}`).not.toContain('csrfToken');
      else expect(schemes, `${method} ${p}`).toContain('csrfToken');
      expect(op.responses['401'], `${method} ${p}`).toBeDefined();
      if (method !== 'get') expect(op.responses['403'], `${method} ${p}`).toBeDefined();
    }
  });

  it('requires the Idempotency-Key header on send, and nowhere else', () => {
    const withKey = allOperations().filter(({ op }) => (op.parameters ?? []).some((p: Json) => p.name === 'Idempotency-Key'));
    expect(withKey.map((o) => o.op.operationId)).toEqual(['sendRequest']);
    const param = withKey[0]?.op.parameters.find((p: Json) => p.name === 'Idempotency-Key');
    expect(param).toMatchObject({ in: 'header', required: true });
  });

  it('documents the error and outcome shapes the client has to handle', () => {
    const codesIn = (op: string, status: string): string[] =>
      Object.keys(allOperations().find((o) => o.op.operationId === op)?.op.responses[status].content['application/problem+json'].examples ?? {});

    expect(codesIn('editRequestDraft', '409')).toContain('draft_changed'); // stale hash
    expect(codesIn('approveRequest', '409')).toEqual(expect.arrayContaining(['draft_changed', 'use_form', 'must_keep', 'kept', 'no_contact']));
    expect(codesIn('sendRequest', '409')).toEqual(expect.arrayContaining(['use_form', 'must_keep', 'kept', 'no_contact', 'approval_required']));
    expect(codesIn('sendRequest', '503')).toEqual(expect.arrayContaining(['real_send_blocked', 'send_disabled']));
    expect(codesIn('sendRequest', '502')).toEqual(expect.arrayContaining(['send_failed', 'send_outcome_unknown']));
    expect(codesIn('createRequestDrafts', '400')).toContain('validation_failed');

    const create = allOperations().find((o) => o.op.operationId === 'createRequestDrafts');
    const outcomes = (create?.op.responses['200'].content['application/json'].example.results as Array<{ outcome: string }>).map((r) => r.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['created', 'use_form', 'kept', 'blocked']));
    expect(spec.components.schemas.DraftOutcome.properties.outcome.enum).toEqual(['created', 'existing', 'use_form', 'kept', 'blocked']);
  });

  it('lists only problem codes the API can return, and every blocker code is one of them', () => {
    for (const code of BLOCKER_CODES) expect(PROBLEM_CODES as readonly string[], code).toContain(code);
    expect(spec.components.schemas.Problem.properties.code.enum).toEqual([...PROBLEM_CODES]);
  });
});

describe('examples in the document', () => {
  it('match their own schemas', () => {
    const failures: string[] = [];
    for (const { path: p, method, op } of allOperations()) {
      for (const [status, r] of Object.entries<Json>(op.responses)) {
        const json = r.content?.['application/json'];
        if (json?.example !== undefined && json.schema?.$ref) {
          const errs = validateAgainst(String(json.schema.$ref).replace('#/components/schemas/', ''), json.example);
          if (errs.length) failures.push(`${method} ${p} ${status}: ${errs.join('; ')}`);
        }
        const problems = r.content?.['application/problem+json']?.examples as Record<string, { value: Json }> | undefined;
        for (const [code, ex] of Object.entries(problems ?? {})) {
          const errs = validateAgainst(problemSchemaFor(code), ex.value);
          if (errs.length) failures.push(`${method} ${p} ${status} ${code}: ${errs.join('; ')}`);
          expect(ex.value.status, `${p} ${code}`).toBe(Number(status));
        }
      }
      const bodySchema = op.requestBody?.content?.['application/json'];
      if (bodySchema?.example !== undefined) {
        const validate = ajv.compile(bodySchema.schema as object);
        if (!validate(bodySchema.example)) failures.push(`${method} ${p} body: ${ajv.errorsText(validate.errors)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('use fictional data only: example.com addresses, no tokens, no real services', () => {
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    for (const e of emails) expect(e, e).toMatch(/@example\.com$/);
    // Token shapes the log scrubber also treats as secrets.
    expect(text).not.toMatch(/\bya29\.|\b1\/\/[A-Za-z0-9._-]{20,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{10,}/);
    // URLs: example.com for fictional things, Google's own sign-in host, and the local dev server.
    const hosts = new Set((text.match(/https?:\/\/[A-Za-z0-9.-]+/g) ?? []).map((u) => new URL(u).hostname));
    for (const h of hosts) expect(['example.com', 'accounts.google.com', 'localhost']).toContain(h);
    expect(text).not.toMatch(/gmail\.com|googlemail|\.in\b/i);
  });

  it('use hedged wording and no banned words (PRD 4.4)', () => {
    expect(text).not.toMatch(/will\s+(be\s+)?delete|guaranteed|non-?compliant|\bcompliant\b|\bviolating\b|\billegal\b|your data is safe|\bleaked\b/i); // banned-words:ignore - the list of banned words itself
    expect(text).not.toContain('!');
  });
});

describe('the code list matches the source', () => {
  /** Every `code` the source can put in a problem response. */
  function sourceCodes(): Set<string> {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'dev') walk(full);
        } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(full);
      }
    };
    walk(root);
    const codes = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:new AppError\(\d{3},|Problems\.(?:unavailable|conflict|badRequest)\()\s*'([a-z_]+)'/g)) codes.add(m[1] as string);
      for (const m of src.matchAll(/code: '([a-z_]+)'/g)) if (f.endsWith('errors.ts') || f.endsWith('auth.guard.ts')) codes.add(m[1] as string);
    }
    // The shorthands in common/errors.ts.
    for (const c of ['unauthorized', 'forbidden', 'not_found', 'rate_limited', 'not_ready', 'internal_error', 'validation_failed', 'malformed_request']) codes.add(c);
    return codes;
  }

  it('lists every code the source can return', () => {
    const documented = new Set<string>(PROBLEM_CODES);
    const undocumented = [...sourceCodes()].filter((c) => !documented.has(c) && !c.startsWith('http_'));
    expect(undocumented).toEqual([]);
  });
});

describe('the README for people building a client', () => {
  const readme = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../openapi/README.md'), 'utf8');

  it('mentions every error code in the contract, so a new code cannot be added without saying what to do about it', () => {
    const missing = PROBLEM_CODES.filter((code) => !readme.includes(`\`${code}\``));
    expect(missing).toEqual([]);
  });

  it('describes the outcome as reported by the person, never as a fact', () => {
    expect(readme).toContain('Reported by you');
    expect(readme).toMatch(/never infers it/);
  });
});

