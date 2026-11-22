import { z } from 'zod';
import { operations, type OperationDoc, type ProblemDoc, type ResponseDoc } from './routes.js';
import { Problem, ProblemDraftUnsafe, ProblemUseForm, ProblemValidation, registry } from './schemas.js';

type Json = Record<string, unknown>;

const HTTP_REASON: Record<number, string> = {
  200: 'OK',
  202: 'Accepted',
  204: 'No Content',
  302: 'Found',
  400: 'Bad request',
  401: 'Not signed in',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable',
  429: 'Too many requests',
  502: 'Bad gateway',
  503: 'Unavailable',
};

/** Where a component is referenced from. */
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });

/** Removes what zod adds that OpenAPI does not want: per-schema ids, and the very long date-time regex. */
function clean<T>(node: T): T {
  if (Array.isArray(node)) return node.map(clean) as T;
  if (node && typeof node === 'object') {
    const src = node as Json;
    const out: Json = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === '$schema' || k === '$id') continue;
      if (k === 'pattern' && src.format === 'date-time') continue;
      // zod bounds every integer to the safe range; that is noise in the contract.
      if ((k === 'minimum' && v === -9007199254740991) || (k === 'maximum' && v === 9007199254740991)) continue;
      out[k] = clean(v);
    }
    return out as T;
  }
  return node;
}

/** The name a component was registered under, if it was. */
const componentName = (schema: z.ZodType): string | undefined => registry.get(schema)?.id;

function inline(schema: z.ZodType, io: 'input' | 'output'): Json {
  return clean(z.toJSONSchema(schema, { target: 'draft-2020-12', io }) as Json);
}

function schemaFor(schema: z.ZodType, io: 'input' | 'output'): Json {
  const name = componentName(schema);
  return name ? ref(name) : inline(schema, io);
}

/** `/v1/requests/:id/send` -> `/v1/requests/{id}/send` */
const openApiPath = (path: string): string => path.replace(/:([A-Za-z]+)/g, '{$1}');

/** `idempotency-key` -> `Idempotency-Key` */
const headerName = (n: string): string => n.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('-');

function parameters(op: OperationDoc): Json[] {
  const out: Json[] = [];
  const add = (where: 'path' | 'query' | 'header', schema: z.ZodObject | undefined): void => {
    if (!schema) return;
    const json = inline(schema, 'input') as { properties?: Record<string, Json>; required?: string[] };
    for (const [name, s] of Object.entries(json.properties ?? {})) {
      const { description, ...rest } = s as { description?: string } & Json;
      out.push({
        name: where === 'header' ? headerName(name) : name,
        in: where,
        required: where === 'path' ? true : (json.required ?? []).includes(name),
        ...(description ? { description } : {}),
        schema: rest,
      });
    }
  };
  add('path', op.params);
  add('query', op.query);
  add('header', op.headers);
  return out;
}

const SPECIALISED: Partial<Record<string, string>> = { use_form: 'ProblemUseForm', draft_unsafe: 'ProblemDraftUnsafe', validation_failed: 'ProblemValidation' };

function problemValue(status: number, p: ProblemDoc): Json {
  return { type: `urn:erase:problem:${p.code}`, title: p.title, status, code: p.code, detail: p.detail, instance: '/v1/example', requestId: '00000000-0000-4000-8000-000000000000', ...(p.extra ?? {}) };
}

function problemResponse(status: number, description: string, problems: ProblemDoc[]): Json {
  const examples: Json = {};
  for (const p of problems) {
    const name = p.code;
    examples[name] = { summary: p.title, value: problemValue(status, p) };
  }
  const specialised = [...new Set(problems.map((p) => SPECIALISED[p.code]).filter((n): n is string => Boolean(n)))];
  return {
    description,
    content: { 'application/problem+json': { schema: ref('Problem'), examples } },
    ...(specialised.length ? { 'x-problem-schemas': specialised } : {}),
  };
}

function response(status: number, r: ResponseDoc): Json {
  if (r.problems) return problemResponse(status, r.description, r.problems);
  if (r.redirect) {
    return {
      description: r.description,
      headers: {
        Location: { description: 'Where the browser goes next', schema: { type: 'string' } },
        'Set-Cookie': { description: 'The `erase_oauth_state` cookie (start, connect) or the `erase_session` cookie (after sign-in)', schema: { type: 'string' } },
      },
    };
  }
  if (!r.schema) return { description: r.description };
  return {
    description: r.description,
    content: { 'application/json': { schema: schemaFor(r.schema, 'output'), ...(r.example !== undefined ? { example: r.example } : {}) } },
  };
}

/** The refusals every operation of its kind can return, documented once instead of on each route. */
function standardResponses(op: OperationDoc): Record<number, Json> {
  const out: Record<number, Json> = {};
  const unsafe = op.method !== 'get';
  if (op.auth) {
    out[401] = problemResponse(401, 'Not signed in', [{ code: 'unauthorized', title: 'Sign in required', detail: 'Send the `erase_session` cookie (sign in first).' }]);
    if (unsafe) {
      out[403] = problemResponse(403, 'Missing or wrong CSRF token, or a request from another origin', [{ code: 'forbidden', title: 'Not allowed', detail: 'Send the `x-csrf-token` from `GET /v1/me` on every state-changing call, from the web app’s origin.' }]);
    }
  }
  if (op.params || op.query || op.body || op.headers) {
    out[400] = problemResponse(400, 'The request did not match the schema', [
      { code: 'validation_failed', title: 'Request validation failed', detail: 'See `errors`. Submitted values are never echoed.', extra: { errors: [{ path: 'userCompanyIds.0', message: 'Invalid string' }] } },
      { code: 'malformed_request', title: 'Bad request', detail: 'The request could not be processed.' },
      ...(op.headers ? [{ code: 'idempotency_key_required' as const, title: 'Idempotency-Key required', detail: 'Send an Idempotency-Key header so a retry cannot send twice.' }] : []),
    ]);
  }
  if (op.rateLimited || op.operationId === 'sendRequest') {
    out[429] = problemResponse(429, 'Too many requests', [{ code: 'rate_limited', title: 'Too many requests', detail: 'Slow down and try again shortly.' }]);
  }
  return out;
}

function operationObject(op: OperationDoc): Json {
  const std = standardResponses(op);
  const explicit: Record<string, Json> = {};
  for (const [status, r] of Object.entries(op.responses)) explicit[status] = response(Number(status), r);
  // Explicit documentation wins; a status given in both places keeps the explicit one but gains the standard examples.
  const merged: Record<string, Json> = {};
  for (const status of [...new Set([...Object.keys(std), ...Object.keys(explicit)])].sort()) {
    merged[status] = explicit[status] ?? (std[Number(status)] as Json);
  }
  return {
    operationId: op.operationId,
    tags: [op.tag],
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(parameters(op).length ? { parameters: parameters(op) } : {}),
    ...(op.body
      ? { requestBody: { required: true, content: { 'application/json': { schema: inline(op.body, 'input'), ...(op.bodyExample !== undefined ? { example: op.bodyExample } : {}) } } } }
      : {}),
    responses: merged,
    security: op.auth ? [op.method === 'get' ? { sessionCookie: [] } : { sessionCookie: [], csrfToken: [] }] : [],
  };
}

const TAGS = [
  { name: 'Auth', description: 'Google sign-in and sign-out. Browser redirects, not JSON.' },
  { name: 'Account', description: 'The signed-in user and account deletion.' },
  { name: 'Inboxes', description: 'Connecting a Gmail inbox and scanning it for companies. Header metadata only.' },
  { name: 'Companies', description: 'Companies that may hold the user’s data, and "keep this".' },
  { name: 'Requests', description: 'Draft, edit, approve and send erasure requests. Nothing is sent without the user’s approval.' },
];

const DESCRIPTION = [
  'The Erase.me core API. Every call is under `/v1`.',
  '',
  '**Sign-in and sessions.** Sign in with `GET /v1/auth/google/start`. The `erase_session` cookie (HttpOnly) identifies the user. Send requests with credentials included.',
  '',
  '**CSRF.** Every POST, PUT, PATCH and DELETE needs the `x-csrf-token` header from `GET /v1/me`, and a browser `Origin` that is the web app.',
  '',
  '**Errors.** Failures are RFC 9457 problem details (`application/problem+json`) with a stable `code`. Branch on `code`, not on the text. The `detail` is a sentence a person can act on and never contains draft text, addresses or tokens.',
  '',
  '**Outcomes that are not errors.** Creating draft requests answers 200 with one outcome per company: `created`, `existing`, `use_form` (a web-form company: the draft is for copy and paste), `kept` (the user chose to keep it) or `blocked` (with a `reason`, for example `must_keep` or `no_contact`).',
  '',
  '**Wording.** Results are hints from header metadata, never statements of fact. The API makes no promise about what a company does with a request.',
  '',
  '**Idempotency.** `POST /v1/requests/{id}/send` needs an `Idempotency-Key` header.',
].join('\n');

export function buildOpenApi(): Json {
  const generated = z.toJSONSchema(registry, { target: 'draft-2020-12', io: 'output', uri: (id) => `#/components/schemas/${id}` }) as { schemas: Record<string, Json> };
  const schemas: Json = {};
  for (const name of Object.keys(generated.schemas).sort()) schemas[name] = clean(generated.schemas[name]);

  const paths: Record<string, Json> = {};
  for (const op of operations) {
    const p = openApiPath(op.path);
    paths[p] = { ...(paths[p] ?? {}), [op.method]: operationObject(op) };
  }
  const sortedPaths: Record<string, Json> = {};
  for (const p of Object.keys(paths).sort()) sortedPaths[p] = paths[p] as Json;

  return {
    openapi: '3.1.0',
    info: { title: 'Erase.me core API', version: '0.1.0', description: DESCRIPTION },
    servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
    tags: TAGS,
    paths: sortedPaths,
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'erase_session', description: 'Set by the sign-in callback. HttpOnly. Send with credentials included.' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'x-csrf-token', description: 'The `csrfToken` from `GET /v1/me`. Required on every state-changing call.' },
      },
      schemas,
    },
  };
}

/** The document as committed: two-space JSON with a trailing newline, keys in a stable order. */
export const serializeOpenApi = (doc: Json = buildOpenApi()): string => `${JSON.stringify(doc, null, 2)}\n`;

// Used by tests to look at the specialised problem schemas without importing the registry.
export const problemSchemas = { Problem, ProblemUseForm, ProblemDraftUnsafe, ProblemValidation };
export { HTTP_REASON };
