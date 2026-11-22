import { z } from 'zod';

const urlWith = (protocols: string[], label: string) =>
  z.string().refine(
    (v) => {
      try {
        return protocols.includes(new URL(v).protocol);
      } catch {
        return false;
      }
    },
    { message: `must be a valid ${label} URL` },
  );

/**
 * An origin: scheme, host and optional port, nothing else. The browser sends exactly this in the `Origin` header,
 * and the API compares it exactly, so a trailing slash or a path in the setting would silently break CORS and the
 * CSRF origin check. A bare origin with a trailing slash is accepted and normalised; anything with a path, query or
 * fragment is refused.
 */
const originUrl = z
  .string()
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return ['http:', 'https:'].includes(u.protocol) && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password;
      } catch {
        return false;
      }
    },
    { message: 'must be an origin such as https://app.example (scheme, host, optional port; no path)' },
  )
  .transform((v) => new URL(v).origin);

const bool = z
  .enum(['true', 'false'], { message: 'must be "true" or "false"' })
  .default('false')
  .transform((v) => v === 'true');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // The web app's origin. Drives CORS, the CSRF origin check and the post-sign-in redirect. It runs on its own port or host.
    WEB_ORIGIN: originUrl.default('http://localhost:3000'),
    // The app connects as the restricted role (INSERT/SELECT only on append-only tables).
    DATABASE_URL: urlWith(['postgres:', 'postgresql:'], 'Postgres'),
    // Migrations run as the owner role. Only the migrate script needs this.
    DATABASE_MIGRATION_URL: urlWith(['postgres:', 'postgresql:'], 'Postgres').optional(),
    REDIS_URL: urlWith(['redis:', 'rediss:'], 'Redis'),
    AI_SERVICE_URL: urlWith(['http:', 'https:'], 'http(s)'),
    AI_SERVICE_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
    // base64 of 32 random bytes. Read through a KeyProvider; never logged, never committed.
    TOKEN_MASTER_KEY: z.string().optional(),
    // Public base URL of this API. The Google redirect URI is API_PUBLIC_URL + /v1/auth/google/callback.
    API_PUBLIC_URL: urlWith(['http:', 'https:'], 'http(s)').default('http://localhost:4000'),
    // Set only when the web app and API sit on sibling subdomains (for example .erase.me). Empty = host-only cookie.
    COOKIE_DOMAIN: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    // Scan limits. Neither raises Gmail request pacing, which is fixed in the client.
    // How many years of mail to scan, counted back from the day the scan starts. Unset means the whole mailbox.
    SCAN_WINDOW_YEARS: z.coerce.number().int().min(1).max(40).optional(),
    // Stop after this many matching messages in one scan.
    SCAN_MAX_MESSAGES: z.coerce.number().int().min(100).max(1_000_000).default(50_000),
    // Senders to leave out of results: registrable domains (an employer) or full addresses, comma separated.
    // The user's own addresses and the domain of a custom-domain inbox are always left out.
    SCAN_EXCLUDE: z.string().optional(),
    // The activity hint (a hint only, never a decision). A receipt or transactional message within RECENT days means
    // "looks in use"; nothing for more than OLD days means "looks unused".
    ACTIVITY_RECENT_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    ACTIVITY_OLD_DAYS: z.coerce.number().int().min(2).max(7300).default(365),
    // Real sends are off by default. Dev and test send only to the fake Gmail.
    ALLOW_REAL_SEND: bool,
    REAL_SEND_DAILY_CAP: z.coerce.number().int().min(0).default(5),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

    if (env.TOKEN_MASTER_KEY !== undefined) {
      const bytes = Buffer.from(env.TOKEN_MASTER_KEY, 'base64');
      if (bytes.length !== 32 || bytes.toString('base64') !== env.TOKEN_MASTER_KEY) {
        issue('TOKEN_MASTER_KEY', 'must be base64 of exactly 32 bytes');
      }
    }
    if ((env.GOOGLE_CLIENT_ID === undefined) !== (env.GOOGLE_CLIENT_SECRET === undefined)) {
      issue('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together');
    }
    if (env.ACTIVITY_OLD_DAYS <= env.ACTIVITY_RECENT_DAYS) {
      issue('ACTIVITY_OLD_DAYS', 'must be greater than ACTIVITY_RECENT_DAYS');
    }
    if (env.ALLOW_REAL_SEND && env.NODE_ENV === 'test') {
      issue('ALLOW_REAL_SEND', 'must be false when NODE_ENV is test');
    }
    if (env.ALLOW_REAL_SEND && env.REAL_SEND_DAILY_CAP < 1) {
      issue('REAL_SEND_DAILY_CAP', 'must be at least 1 when ALLOW_REAL_SEND is true');
    }
    if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
      if (env.TOKEN_MASTER_KEY === undefined) issue('TOKEN_MASTER_KEY', 'is required in staging and production');
      if (env.AI_SERVICE_TOKEN === undefined) issue('AI_SERVICE_TOKEN', 'is required in staging and production');
      if (!env.WEB_ORIGIN.startsWith('https:')) issue('WEB_ORIGIN', 'must be https in staging and production');
      if (!env.API_PUBLIC_URL.startsWith('https:')) issue('API_PUBLIC_URL', 'must be https in staging and production');
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface EnvIssue {
  variable: string;
  message: string;
}

/** Thrown for invalid configuration. Lists variable names and rules only, never values. */
export class EnvError extends Error {
  constructor(readonly issues: EnvIssue[]) {
    super(`Invalid environment: ${issues.map((i) => `${i.variable} ${i.message}`).join('; ')}`);
    this.name = 'EnvError';
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // An empty value (for example `TOKEN_MASTER_KEY=` copied from .env.example) means "not set".
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    throw new EnvError(
      parsed.error.issues.map((i) => ({ variable: String(i.path[0] ?? '(root)'), message: i.message })),
    );
  }
  return parsed.data;
}

export const GOOGLE_CALLBACK_PATH = '/v1/auth/google/callback';

/** The exact redirect URI registered in Google Cloud. */
export function googleRedirectUri(env: Pick<Env, 'API_PUBLIC_URL'>): string {
  return new URL(GOOGLE_CALLBACK_PATH, env.API_PUBLIC_URL).toString();
}

/** A real send needs ALLOW_REAL_SEND=true, a positive per-user daily cap, and a non-test environment. */
export function isRealSendEnabled(env: Env): boolean {
  return env.ALLOW_REAL_SEND && env.NODE_ENV !== 'test' && env.REAL_SEND_DAILY_CAP > 0;
}
