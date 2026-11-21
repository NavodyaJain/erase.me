import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../common/errors.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is ready when every check passes', async () => {
    const svc = new HealthService(async () => undefined);
    await expect(svc.readiness()).resolves.toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('throws a 503 not_ready problem when a check fails, and reports the failure once', async () => {
    const failures: string[] = [];
    const svc = new HealthService(
      async () => {
        throw new Error('down');
      },
      (check) => failures.push(check),
    );
    const err = await svc.readiness().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 503, code: 'not_ready', extensions: { checks: { database: 'fail' } } });
    expect(failures).toEqual(['database']);
  });

  it('treats a hanging check as failed after 2 seconds', async () => {
    const svc = new HealthService(() => new Promise<void>(() => undefined));
    const result = svc.readiness().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ status: 503, code: 'not_ready' });
  });
});
