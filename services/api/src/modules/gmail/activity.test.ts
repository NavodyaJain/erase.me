import { describe, expect, it } from 'vitest';
import { activityHint, DEFAULT_ACTIVITY } from './activity.js';

const NOW = new Date('2026-11-22T12:00:00Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('activityHint', () => {
  it('uses 90 and 365 days by default', () => {
    expect(DEFAULT_ACTIVITY).toEqual({ recentDays: 90, oldDays: 365 });
  });

  it('looks in use with a receipt or transactional message in the last 90 days, boundary included', () => {
    expect(activityHint({ lastSeen: daysAgo(1), lastTransactionalAt: daysAgo(10) }, NOW)).toBe('looks_in_use');
    expect(activityHint({ lastSeen: daysAgo(90), lastTransactionalAt: daysAgo(90) }, NOW)).toBe('looks_in_use');
    expect(activityHint({ lastSeen: daysAgo(91), lastTransactionalAt: daysAgo(91) }, NOW)).toBeNull();
  });

  it('looks unused when the last message of any kind is more than 365 days old, boundary excluded', () => {
    expect(activityHint({ lastSeen: daysAgo(366), lastTransactionalAt: null }, NOW)).toBe('looks_unused');
    expect(activityHint({ lastSeen: daysAgo(400), lastTransactionalAt: daysAgo(500) }, NOW)).toBe('looks_unused');
    expect(activityHint({ lastSeen: daysAgo(365), lastTransactionalAt: null }, NOW)).toBeNull();
  });

  it('gives no hint in between, and a newsletter alone never makes a company look in use', () => {
    expect(activityHint({ lastSeen: daysAgo(1), lastTransactionalAt: null }, NOW)).toBeNull(); // only newsletters lately
    expect(activityHint({ lastSeen: daysAgo(5), lastTransactionalAt: daysAgo(200) }, NOW)).toBeNull(); // an old receipt, a recent newsletter
    expect(activityHint({ lastSeen: daysAgo(200), lastTransactionalAt: null }, NOW)).toBeNull();
  });

  it('gives no "in use" hint for a company scanned before receipt dates were recorded, until a rescan', () => {
    expect(activityHint({ lastSeen: daysAgo(2), lastTransactionalAt: null }, NOW)).toBeNull();
  });

  it('follows the configured thresholds', () => {
    const cfg = { recentDays: 30, oldDays: 60 };
    expect(activityHint({ lastSeen: daysAgo(1), lastTransactionalAt: daysAgo(30) }, NOW, cfg)).toBe('looks_in_use');
    expect(activityHint({ lastSeen: daysAgo(1), lastTransactionalAt: daysAgo(31) }, NOW, cfg)).toBeNull();
    expect(activityHint({ lastSeen: daysAgo(61), lastTransactionalAt: null }, NOW, cfg)).toBe('looks_unused');
  });
});
