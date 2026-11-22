/**
 * The activity hint (PRD 4.4 wording: "looks in use", "looks unused"): a hint for the user, never a decision, and
 * never a reason to send or hold back a request. It uses only dates the scan already recorded from message headers:
 * when the company last sent anything, and when it last sent a receipt or a transactional message. No email bodies.
 */
export type ActivityHint = 'looks_in_use' | 'looks_unused';

export interface ActivityConfig {
  /** A receipt or transactional message at most this many days old means the company looks in use. */
  recentDays: number;
  /** Nothing at all for more than this many days means the company looks unused. */
  oldDays: number;
}

export const DEFAULT_ACTIVITY: ActivityConfig = { recentDays: 90, oldDays: 365 };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * - `looks_in_use`: a receipt or transactional message within `recentDays` (inclusive).
 * - `looks_unused`: the last message of any kind is more than `oldDays` old.
 * - `null`: anything else, including a company that only sends newsletters, or one scanned before the receipt date
 *   was recorded, whose last message is not yet old. A newsletter never makes a company look in use.
 */
export function activityHint(
  c: { lastSeen: Date; lastTransactionalAt: Date | null },
  now: Date,
  cfg: ActivityConfig = DEFAULT_ACTIVITY,
): ActivityHint | null {
  if (c.lastTransactionalAt && now.getTime() - c.lastTransactionalAt.getTime() <= cfg.recentDays * DAY_MS) return 'looks_in_use';
  if (now.getTime() - c.lastSeen.getTime() > cfg.oldDays * DAY_MS) return 'looks_unused';
  return null;
}
