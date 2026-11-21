/**
 * Fixed-window limiter, in memory (one API process in Phase 1; move to Redis with the queues).
 * Keys are held only in memory and never logged.
 */
export function createRateLimiter(opts: { max: number; windowMs: number; now?: () => number }) {
  const now = opts.now ?? (() => Date.now());
  const windows = new Map<string, { start: number; count: number }>();
  return {
    /** Returns true if the call is allowed. */
    allow(key: string): boolean {
      const t = now();
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (t - w.start >= opts.windowMs) windows.delete(k);
      }
      const w = windows.get(key);
      if (!w || t - w.start >= opts.windowMs) {
        windows.set(key, { start: t, count: 1 });
        return true;
      }
      w.count += 1;
      return w.count <= opts.max;
    },
  };
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;
