/**
 * Background work behind an interface. Phase 1 runs jobs in this process; BullMQ on Redis replaces
 * InProcessJobQueue when workers move out of the API (TRD 6.5). Handlers must be idempotent: a job can
 * be delivered more than once and is re-run after a restart.
 */
export interface JobQueue {
  enqueue(name: string, payload: Record<string, string>): void;
}

export type JobHandler = (payload: Record<string, string>) => Promise<void>;

export class InProcessJobQueue implements JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly onFailure: (name: string, err: unknown) => void) {}

  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  enqueue(name: string, payload: Record<string, string>): void {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`no handler registered for job ${name}`);
    const run = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => handler(payload))
      .catch((err: unknown) => this.onFailure(name, err))
      .finally(() => this.running.delete(run));
    this.running.add(run);
  }

  /** Resolves when every job started so far has finished. Used by tests and graceful shutdown. */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }
}
