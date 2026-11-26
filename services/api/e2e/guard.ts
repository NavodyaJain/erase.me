import type { Env } from '../src/config/env.js';

/**
 * The end-to-end stack replaces Google with a fake and signs a fictional person in. It must never run anywhere real,
 * so it refuses unless every one of these holds. The production entry (src/server.ts) never imports this folder, and
 * a test checks that.
 */
/**
 * Checked against the environment the process was started with, before the e2e entry sets its own values over it. Without
 * this, starting it with NODE_ENV=production would be silently turned into a development run.
 */
export function assertE2eLaunchAllowed(source: Record<string, string | undefined>): void {
  const problems: string[] = [];
  if (source.E2E_MODE !== 'true') problems.push('E2E_MODE must be "true"');
  if (source.NODE_ENV === 'production' || source.NODE_ENV === 'staging') problems.push(`NODE_ENV must not be ${source.NODE_ENV}`);
  if (source.ALLOW_REAL_SEND === 'true') problems.push('ALLOW_REAL_SEND must be false');
  if (problems.length) throw new Error(`The e2e stack refused to start: ${problems.join('; ')}`);
}

export function assertE2eAllowed(env: Pick<Env, 'NODE_ENV' | 'ALLOW_REAL_SEND'>, source: Record<string, string | undefined>): void {
  const problems: string[] = [];
  if (source.E2E_MODE !== 'true') problems.push('E2E_MODE must be "true"');
  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') problems.push(`NODE_ENV must not be ${env.NODE_ENV}`);
  if (env.ALLOW_REAL_SEND) problems.push('ALLOW_REAL_SEND must be false');
  const url = parse(source.DATABASE_URL);
  const db = url?.pathname.replace(/^\//, '');
  if (!db || !/_e2e$/.test(db)) problems.push('DATABASE_URL must point to a database whose name ends in _e2e');
  if (url && !['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(url.hostname)) problems.push('DATABASE_URL must be a local database');
  if (problems.length) throw new Error(`The e2e stack refused to start: ${problems.join('; ')}`);
}

function parse(value: string | undefined): URL | undefined {
  try {
    return value ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}
