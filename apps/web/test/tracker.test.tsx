import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { OverviewScreen } from '@/components/OverviewScreen';
import { RequestsList } from '@/components/RequestsList';
import { copy } from '@/copy/en';
import { findViolations } from './banned';
import { problem, renderApp } from './helpers';

const item = (n: number, status: string, over: Record<string, unknown> = {}) => ({
  id: `req_${n}`,
  status,
  company: { name: `Examplo ${n}`, mustKeep: false },
  channel: 'email',
  outcome: null,
  createdAt: '2026-11-19T09:00:00.000Z',
  updatedAt: '2026-11-19T09:00:00.000Z',
  sentAt: status === 'drafted' || status === 'approved' ? null : '2026-11-21T09:00:00.000Z',
  dueAt: status === 'sent' ? '2026-12-21T09:00:00.000Z' : null,
  replies: { count: 0, automaticCount: 0 },
  followup: { state: 'none', canCreate: false },
  ...over,
});
const LIST = [
  item(1, 'replied_deleted'),
  item(2, 'reply_received'),
  item(3, 'no_reply', { followup: { state: 'due', canCreate: true } }),
  item(4, 'sent', { replies: { count: 0, automaticCount: 1 }, followup: { state: 'not_due', canCreate: false } }),
  item(5, 'drafted'),
  item(6, 'sent', { followup: { state: 'not_due', canCreate: false } }),
];
const list = () => ({ 'GET /v1/requests': { body: { requests: LIST } } });
const names = () => within(screen.getByRole('list')).getAllByRole('link').map((l) => l.textContent);
const total = (label: string) => within(screen.getByLabelText(copy.tracker.summaryLabel)).getByText(label).parentElement?.querySelector('dd')?.textContent;

describe('the request list', () => {
  it('counts sent, replied, waiting and reported erased, and says the last is the person’s report', async () => {
    const { container } = renderApp(<RequestsList />, list());
    await screen.findByLabelText(copy.tracker.summaryLabel);
    expect([total(copy.tracker.sent), total(copy.tracker.replied), total(copy.tracker.waiting), total(copy.tracker.erased)]).toEqual(['5', '1', '3', '1']);
    expect(screen.getByText(copy.tracker.erasedNote)).toBeTruthy();
    // Never a bare claim that something was deleted.
    expect(container.textContent).not.toMatch(/\bDeleted\b/);
    expect(findViolations(container.textContent ?? '')).toEqual([]);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('filters, and marks the chosen filter as pressed', async () => {
    renderApp(<RequestsList />, list());
    await screen.findByRole('link', { name: 'Examplo 1' });
    const choose = (name: string) => userEvent.click(screen.getByRole('button', { name }));
    await choose(copy.tracker.filters.needs_you);
    expect(names()).toEqual(['Examplo 2', 'Examplo 3', 'Examplo 5']);
    expect(screen.getByRole('button', { name: copy.tracker.filters.needs_you }).getAttribute('aria-pressed')).toBe('true');
    await choose(copy.tracker.filters.waiting);
    expect(names()).toEqual(['Examplo 3', 'Examplo 4', 'Examplo 6']);
    await choose(copy.tracker.filters.erased);
    expect(names()).toEqual(['Examplo 1']);
    await choose(copy.tracker.filters.all);
    expect(names()).toHaveLength(6);
  });

  it('offers the follow-up in a banner, and says in words what each row is doing', async () => {
    renderApp(<RequestsList />, list());
    expect(await screen.findByText(copy.tracker.followupBanner('Examplo 3'))).toBeTruthy();
    expect(screen.getByRole('link', { name: copy.tracker.followupBannerAction }).getAttribute('href')).toBe('/requests/req_3');
    expect(screen.getByText(copy.tracker.rowFollowupDue)).toBeTruthy();
    expect(screen.getByText(new RegExp(copy.tracker.rowAutomatic))).toBeTruthy();
    expect(screen.getByText(new RegExp(copy.tracker.rowDue('21 Dec 2026')))).toBeTruthy();
    expect(screen.getAllByText(copy.labels.requestStatus.replied_deleted).length).toBeGreaterThan(0);
    // Progress is words as well as bars.
    expect(screen.getByRole('img', { name: copy.tracker.progressLabel(copy.tracker.progress.reported) })).toBeTruthy();
    expect(screen.getByRole('img', { name: copy.tracker.progressLabel(copy.tracker.progress.replied) })).toBeTruthy();
  });

  it('says when a filter matches nothing, and shows no summary or banner for an empty list', async () => {
    const a = renderApp(<RequestsList />, { 'GET /v1/requests': { body: { requests: [item(1, 'drafted')] } } });
    await userEvent.click(await within(a.container).findByRole('button', { name: copy.tracker.filters.erased }));
    expect(within(a.container).getByText(copy.tracker.noneMatch)).toBeTruthy();
    a.unmount();
    const b = renderApp(<RequestsList />, { 'GET /v1/requests': { body: { requests: [] } } });
    expect(await within(b.container).findByText(copy.requests.listEmpty)).toBeTruthy();
    expect(within(b.container).queryByLabelText(copy.tracker.summaryLabel)).toBeNull();
    expect(within(b.container).queryByRole('button', { name: copy.tracker.filters.all })).toBeNull();
  });
});

describe('Overview with tracking', () => {
  const INBOX = { id: 'inb_1', email: 'asha.mail@example.com', status: 'connected', connectedAt: '2026-11-20T09:30:00.000Z', lastScanAt: null };
  const routes = (requests: unknown[], inboxes: unknown[] = [INBOX]) => ({
    'GET /v1/companies': { body: { companies: [] } },
    'GET /v1/inboxes': { body: { inboxes } },
    'GET /v1/requests': { body: { requests } },
    'GET /v1/inboxes/inb_1/scan': problem(404, 'not_found'),
  });

  it('Control counts everything ever sent, whatever happened since, links to the requests, and notes reports', async () => {
    renderApp(<OverviewScreen />, routes(LIST));
    const control = await screen.findByLabelText(copy.overview.cards.control);
    await waitFor(() => expect(within(control).getByText('5')).toBeTruthy());
    expect(within(control).getByRole('link', { name: copy.overview.cards.control }).getAttribute('href')).toBe('/requests');
    expect(within(control).getByText(copy.overview.cards.controlErased(1))).toBeTruthy();
    expect(within(screen.getByLabelText(copy.overview.cards.companies)).getByRole('link').getAttribute('href')).toBe('#companies');
  });

  it('ranks "Do this next": reconnect, drafts, follow-up drafts, replies, more information, follow-ups due', async () => {
    const requests = [
      item(3, 'sent', { followup: { state: 'due', canCreate: true } }),
      item(4, 'replied_info_requested'),
      item(2, 'reply_received'),
      item(7, 'no_reply', { followup: { state: 'approved', canCreate: false } }),
      item(5, 'drafted'),
    ];
    const { container } = renderApp(<OverviewScreen />, routes(requests, [{ ...INBOX, status: 'error' }]));
    const n = copy.overview.next;
    await screen.findByText(n.reconnect(1));
    const text = container.textContent ?? '';
    const order = [n.reconnect(1), n.drafts(1), n.followupDrafts(1, 'Examplo 7'), n.replies(1, 'Examplo 2'), n.moreInfo(1, 'Examplo 4'), n.followupDue(1, 'Examplo 3')].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(screen.getByRole('link', { name: n.reconnectAction }).getAttribute('href')).toBe('/connect');
    expect(screen.getAllByRole('link', { name: n.view }).map((l) => l.getAttribute('href'))).toEqual(['/requests/req_2', '/requests/req_4', '/requests/req_3']);
    expect(findViolations(text)).toEqual([]);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('says nothing needs the person when nothing does', async () => {
    renderApp(<OverviewScreen />, routes([item(6, 'sent', { followup: { state: 'not_due', canCreate: false } })]));
    expect(await screen.findByText(copy.overview.next.allClear)).toBeTruthy();
  });
});
