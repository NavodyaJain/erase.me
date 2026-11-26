import type { Inbox, RequestListItem } from '@erase/contracts';
import { describe, expect, it } from 'vitest';
import { canClose, matches, needsYou, nextActions, summarise } from '@/lib/tracking';

let n = 0;
const item = (status: RequestListItem['status'], over: Partial<RequestListItem> = {}): RequestListItem => {
  n += 1;
  return {
    id: `req_${n}`,
    status,
    company: { name: `Examplo ${n}`, mustKeep: false },
    channel: 'email',
    outcome: null,
    createdAt: '2026-11-20T09:00:00.000Z',
    updatedAt: '2026-11-20T09:00:00.000Z',
    sentAt: status === 'drafted' || status === 'approved' ? null : '2026-11-21T09:00:00.000Z',
    dueAt: null,
    replies: { count: 0, automaticCount: 0 },
    followup: { state: 'none', canCreate: false },
    ...over,
  };
};
const inbox = (status: Inbox['status']): Inbox => ({ id: `inb_${status}`, email: 'a@example.com', status, connectedAt: '2026-11-20T09:00:00.000Z', lastScanAt: null });

describe('summary and filters', () => {
  const list = [item('drafted'), item('sent'), item('no_reply'), item('reply_received'), item('replied_refused'), item('replied_info_requested'), item('replied_deleted'), item('closed')];

  it('counts everything ever sent, and keeps replied, waiting and reported erased apart', () => {
    expect(summarise(list)).toEqual({ sent: 7, replied: 3, waiting: 2, reportedErased: 1 });
  });

  it('filters by what is waiting, reported erased, or needs the person', () => {
    const statuses = (f: Parameters<typeof matches>[1]) => list.filter((r) => matches(r, f)).map((r) => r.status);
    expect(statuses('all')).toHaveLength(8);
    expect(statuses('waiting')).toEqual(['sent', 'no_reply']);
    expect(statuses('erased')).toEqual(['replied_deleted']);
    expect(statuses('needs_you')).toEqual(['drafted', 'reply_received', 'replied_info_requested']);
  });

  it('a follow-up that is drafted, approved or due needs the person; a blocked or later one does not', () => {
    expect(needsYou(item('no_reply', { followup: { state: 'drafted', canCreate: false } }))).toBe(true);
    expect(needsYou(item('no_reply', { followup: { state: 'approved', canCreate: false } }))).toBe(true);
    expect(needsYou(item('sent', { followup: { state: 'due', canCreate: true } }))).toBe(true);
    expect(needsYou(item('sent', { followup: { state: 'due', canCreate: false } }))).toBe(false);
    expect(needsYou(item('sent', { followup: { state: 'not_due', canCreate: false } }))).toBe(false);
  });

  it('offers Close only where the API accepts it', () => {
    expect((['drafted', 'approved', 'no_reply', 'replied_deleted', 'replied_refused', 'replied_info_requested'] as const).every(canClose)).toBe(true);
    expect((['sent', 'reply_received', 'closed', 'bounced'] as const).some(canClose)).toBe(false);
  });
});

describe('Do this next', () => {
  it('ranks: reconnect, drafts, follow-up drafts, replies, more information, follow-ups due', () => {
    const requests = [
      item('sent', { followup: { state: 'due', canCreate: true } }),
      item('replied_info_requested'),
      item('reply_received'),
      item('no_reply', { followup: { state: 'drafted', canCreate: false } }),
      item('drafted'),
    ];
    const kinds = nextActions({ inboxes: [inbox('connected'), inbox('error')], requests, companies: 4 }).map((a) => a.kind);
    expect(kinds).toEqual(['reconnect', 'drafts', 'followup_drafts', 'replies', 'more_info', 'followup_due']);
  });

  it('links one request to its own screen, and several to the list', () => {
    const one = item('reply_received');
    expect(nextActions({ inboxes: [inbox('connected')], requests: [one], companies: 0 })[0]).toMatchObject({ kind: 'replies', count: 1, href: `/requests/${one.id}` });
    expect(nextActions({ inboxes: [inbox('connected')], requests: [item('reply_received'), item('reply_received')], companies: 0 })[0]).toMatchObject({ count: 2, href: '/requests' });
  });

  it('asks to connect when no inbox is live, to choose when companies wait, and otherwise says nothing', () => {
    expect(nextActions({ inboxes: [], requests: [], companies: 0 }).map((a) => a.kind)).toEqual(['connect']);
    expect(nextActions({ inboxes: [inbox('disconnected')], requests: [], companies: 3 }).map((a) => a.kind)).toEqual(['connect']);
    expect(nextActions({ inboxes: [inbox('connected')], requests: [], companies: 3 }).map((a) => a.kind)).toEqual(['choose']);
    expect(nextActions({ inboxes: [inbox('connected')], requests: [], companies: 0 })).toEqual([]);
  });

  it('does not offer a follow-up that a guard blocks', () => {
    const blocked = item('sent', { followup: { state: 'due', canCreate: false } });
    expect(nextActions({ inboxes: [inbox('connected')], requests: [blocked], companies: 0 })).toEqual([]);
  });
});
