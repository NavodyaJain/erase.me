const month = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** `2025-01-11` or an ISO timestamp -> `Jan 2025`. */
export const formatMonth = (iso: string): string => month.format(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso));
/** An ISO timestamp -> `22 Nov 2026`. */
export const formatDay = (iso: string): string => dayMonth.format(new Date(iso));
