import type { Inbox, RequestListItem } from '@erase/contracts';

/**
 * What the screens derive from the request list. Pure functions, so the rules are tested in one place. Nothing here
 * infers what a company did: an outcome exists only because the person reported it.
 */
type Status = RequestListItem['status'];

const WAITING: readonly Status[] = ['sent', 'no_reply'];
const ANSWERED: readonly Status[] = ['reply_received', 'replied_info_requested', 'replied_refused'];
/** Where the API allows a request to be closed. A sent one, and one with an unreported reply, cannot be. */
const CLOSABLE: readonly Status[] = ['drafted', 'approved', 'no_reply', 'replied_deleted', 'replied_info_requested', 'replied_refused'];

export const canClose = (status: Status): boolean => CLOSABLE.includes(status);
export const isUnsent = (status: Status): boolean => status === 'drafted' || status === 'approved';

export const hasFollowupDraft = (r: RequestListItem): boolean => r.followup.state === 'drafted' || r.followup.state === 'approved';

/** Something only the person can move on: a draft to approve, a reply to read, more information asked for, or a follow-up. */
export const needsYou = (r: RequestListItem): boolean =>
  isUnsent(r.status) || r.status === 'reply_received' || r.status === 'replied_info_requested' || hasFollowupDraft(r) || r.followup.canCreate;

export type Filter = 'all' | 'needs_you' | 'waiting' | 'erased';

export function matches(r: RequestListItem, filter: Filter): boolean {
  if (filter === 'needs_you') return needsYou(r);
  if (filter === 'waiting') return WAITING.includes(r.status);
  if (filter === 'erased') return r.status === 'replied_deleted';
  return true;
}

export interface Summary {
  /** Everything ever sent or submitted, whatever happened since. */
  sent: number;
  replied: number;
  waiting: number;
  /** Requests the person reported as confirmed erased. A report, not a verified fact. */
  reportedErased: number;
}

export function summarise(requests: RequestListItem[]): Summary {
  return {
    sent: requests.filter((r) => r.sentAt !== null).length,
    replied: requests.filter((r) => ANSWERED.includes(r.status)).length,
    waiting: requests.filter((r) => WAITING.includes(r.status)).length,
    reportedErased: requests.filter((r) => r.status === 'replied_deleted').length,
  };
}

export type NextAction =
  | { kind: 'reconnect'; count: number; href: string }
  | { kind: 'drafts'; count: number; href: string }
  | { kind: 'followup_drafts'; count: number; company: string; href: string }
  | { kind: 'replies'; count: number; company: string; href: string }
  | { kind: 'more_info'; count: number; company: string; href: string }
  | { kind: 'followup_due'; count: number; company: string; href: string }
  | { kind: 'connect'; href: string }
  | { kind: 'choose'; href: string };

/**
 * "Do this next", ranked (PRD F3): a broken inbox first because nothing is checked without it, then drafts waiting for
 * approval, then replies that need the person, then follow-ups that are due. Connecting or choosing comes last.
 */
export function nextActions(input: { inboxes: Inbox[]; requests: RequestListItem[]; companies: number }): NextAction[] {
  const { inboxes, requests, companies } = input;
  const out: NextAction[] = [];
  const group = (kind: 'followup_drafts' | 'replies' | 'more_info' | 'followup_due', list: RequestListItem[]) => {
    const first = list[0];
    if (first) out.push({ kind, count: list.length, company: first.company.name, href: list.length === 1 ? `/requests/${first.id}` : '/requests' });
  };

  const broken = inboxes.filter((i) => i.status === 'error').length;
  if (broken) out.push({ kind: 'reconnect', count: broken, href: '/connect' });

  const drafts = requests.filter((r) => isUnsent(r.status)).length;
  if (drafts) out.push({ kind: 'drafts', count: drafts, href: '/requests/review' });
  group('followup_drafts', requests.filter(hasFollowupDraft));

  group('replies', requests.filter((r) => r.status === 'reply_received'));
  group('more_info', requests.filter((r) => r.status === 'replied_info_requested'));

  group('followup_due', requests.filter((r) => r.followup.canCreate));

  if (inboxes.every((i) => i.status === 'disconnected')) out.push({ kind: 'connect', href: '/connect' });
  else if (companies > 0 && drafts === 0) out.push({ kind: 'choose', href: '/overview' });
  return out;
}
