import { Problems } from '../../common/errors.js';

export type CheckResult = 'ok' | 'fail';

export interface Readiness {
  status: 'ok';
  checks: Record<string, CheckResult>;
}

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('check timed out')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('check failed'));
      },
    );
  });
}

export class HealthService {
  constructor(
    private readonly pingDatabase: () => Promise<void>,
    private readonly onFailure: (check: string, err: unknown) => void = () => undefined,
  ) {}

  /** Throws a 503 problem (listing which checks failed, nothing else) when a dependency is down. */
  async readiness(): Promise<Readiness> {
    const checks: Record<string, CheckResult> = { database: await this.run('database', this.pingDatabase) };
    if (Object.values(checks).includes('fail')) throw Problems.notReady(checks);
    return { status: 'ok', checks };
  }

  private async run(name: string, fn: () => Promise<void>): Promise<CheckResult> {
    try {
      await withTimeout(fn(), CHECK_TIMEOUT_MS);
      return 'ok';
    } catch (err) {
      this.onFailure(name, err);
      return 'fail';
    }
  }
}
