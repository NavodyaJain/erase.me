import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { OverviewScreen } from '@/components/OverviewScreen';
import { copy } from '@/copy/en';
import { ERROR_MESSAGES } from '@/copy/errors';
import { findViolations } from './banned';
import { problem, renderApp } from './helpers';

const id = (n: number) => `ucm_${String(n).padStart(26, '0')}`;
const company = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  company: `Examplo ${n}`,
  domain: `examplo${n}.example`,
  firstSeen: '2024-03-02',
  lastSeen: '2026-10-15',
  signals: ['welcome', 'receipt'],
  confidence: 'high',
  mustKeep: false,
  category: 'saas',
  selfServeUrl: null,
  kept: false,
  activity: null,
  openRequest: null,
  ...over,
});
const INBOX = { id: 'inb_1', email: 'asha.mail@example.com', status: 'connected', connectedAt: '2026-11-20T09:30:00.000Z', lastScanAt: '2026-11-21T09:30:00.000Z' };
const base = (companies: unknown[], requests: unknown[] = []) => ({
  'GET /v1/companies': { body: { companies } },
  'GET /v1/inboxes': { body: { inboxes: [INBOX] } },
  'GET /v1/requests': { body: { requests } },
  'GET /v1/inboxes/inb_1/scan': problem(404, 'not_found'),
});

describe('Overview', () => {
  it('shows the Phase 1 cards: Companies, Control = requests sent, and Money and Risk as Not available yet', async () => {
    const { container } = renderApp(<OverviewScreen />, base([company(1), company(2)], [{ id: 'req_1', status: 'sent' }, { id: 'req_2', status: 'drafted' }]));
    const control = await screen.findByLabelText(copy.overview.cards.control);
    await waitFor(() => expect(within(control).getByText('1')).toBeTruthy());
    expect(within(screen.getByLabelText(copy.overview.cards.companies)).getByText('2')).toBeTruthy();
    expect(within(screen.getByLabelText(copy.overview.cards.money)).getByText(copy.overview.cards.notAvailable)).toBeTruthy();
    expect(within(screen.getByLabelText(copy.overview.cards.risk)).getByText(copy.overview.cards.notAvailable)).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows Likely and Possible, the activity hint, and a self-serve link', async () => {
    renderApp(<OverviewScreen />, base([company(1, { activity: 'looks_unused', selfServeUrl: 'https://examplo1.example/delete-account' }), company(2, { confidence: 'low', activity: 'looks_in_use', signals: ['newsletter'] })]));
    await screen.findByText('Examplo 1');
    expect(screen.getAllByText('Likely').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Possible').length).toBeGreaterThan(0);
    expect(screen.getByText(copy.labels.activity.looks_unused)).toBeTruthy();
    expect(screen.getByText(copy.labels.activity.looks_in_use)).toBeTruthy();
    const link = screen.getByRole('link', { name: copy.overview.company.selfServe('Examplo 1') });
    expect(link.getAttribute('href')).toBe('https://examplo1.example/delete-account');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('explains a must-keep company, offers no Keep switch, and cannot select it', async () => {
    renderApp(<OverviewScreen />, base([company(1, { mustKeep: true })]));
    await screen.findByText(copy.overview.company.mustKeep);
    expect((screen.getByRole('checkbox', { name: copy.overview.company.select('Examplo 1') }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(document.body.textContent).not.toMatch(/will (be )?delete/i);
  });

  it('turns Keep on with PUT and the CSRF header, and undoes it if the server refuses', async () => {
    const { api } = renderApp(<OverviewScreen />, { ...base([company(1)]), [`PUT /v1/companies/${id(1)}/keep`]: { body: { company: company(1, { kept: true }) } } });
    await userEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(api.calls(`PUT /v1/companies/${id(1)}/keep`)).toHaveLength(1));
    expect(api.calls(`PUT /v1/companies/${id(1)}/keep`)[0]?.headers.get('x-csrf-token')).toBe('csrf-token-1');
  });

  it('rolls Keep back and says so when the server refuses', async () => {
    renderApp(<OverviewScreen />, { ...base([company(2)]), [`PUT /v1/companies/${id(2)}/keep`]: problem(409, 'must_keep') });
    await userEvent.click(await screen.findByRole('switch'));
    expect(await screen.findByText(copy.overview.company.keepFailed)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'));
  });

  it('removes Keep with DELETE', async () => {
    const { api } = renderApp(<OverviewScreen />, { ...base([company(1, { kept: true })]), [`DELETE /v1/companies/${id(1)}/keep`]: { body: { company: company(1) } } });
    await screen.findByText(copy.overview.company.kept);
    await userEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(api.calls(`DELETE /v1/companies/${id(1)}/keep`)).toHaveLength(1));
  });

  it('"Do this next" shows only Phase 1 actions', async () => {
    renderApp(<OverviewScreen />, { ...base([]), 'GET /v1/inboxes': { body: { inboxes: [] } } });
    expect(await screen.findByText(copy.overview.next.connect)).toBeTruthy();
    expect(screen.getByRole('link', { name: copy.overview.next.connectAction }).getAttribute('href')).toBe('/connect');
    const text = document.body.textContent ?? '';
    for (const word of ['alias', 'KYC', 'Chase', 'proof pack', 'rotate']) expect(text).not.toContain(word);
  });

  it('points to review when drafts exist', async () => {
    renderApp(<OverviewScreen />, base([company(1)], [{ id: 'req_1', status: 'drafted' }]));
    expect(await screen.findByText(copy.overview.next.drafts(1))).toBeTruthy();
    expect(screen.getByRole('link', { name: copy.overview.next.draftsAction }).getAttribute('href')).toBe('/requests/review');
  });

  it('shows progress while a scan runs', async () => {
    renderApp(<OverviewScreen />, { ...base([]), 'GET /v1/inboxes/inb_1/scan': { body: { scan: { id: 's', inboxId: 'inb_1', status: 'running', progressPct: 55, foundCount: 4, startedAt: null, finishedAt: null, errorCode: null } } } });
    expect((await screen.findByRole('progressbar')).getAttribute('aria-valuenow')).toBe('55');
  });

  it('shows the empty state', async () => {
    renderApp(<OverviewScreen />, { ...base([]), 'GET /v1/inboxes': { body: { inboxes: [] } } });
    expect(await screen.findByText(copy.overview.list.empty)).toBeTruthy();
  });

  it('shows an error with retry when the list cannot load', async () => {
    renderApp(<OverviewScreen />, { ...base([]), 'GET /v1/companies': problem(503, 'not_ready') });
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_MESSAGES.not_ready);
  });

  it('filters by Possible and Kept', async () => {
    renderApp(<OverviewScreen />, base([company(1), company(2, { confidence: 'low' }), company(3, { kept: true })]));
    await screen.findByText('Examplo 1');
    await userEvent.click(screen.getByRole('button', { name: copy.overview.list.filterPossible }));
    expect(screen.queryByText('Examplo 1')).toBeNull();
    expect(screen.getByText('Examplo 2')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: copy.overview.list.filterKept }));
    expect(screen.getByText('Examplo 3')).toBeTruthy();
  });

  it('uses rule-abiding wording', async () => {
    renderApp(<OverviewScreen />, base([company(1, { mustKeep: true }), company(2, { kept: true })]));
    await screen.findByText('Examplo 1');
    expect(findViolations(document.body.textContent ?? '')).toEqual([]);
  });
});

describe('Overview: create drafts and every outcome', () => {
  const outcomes = [
    { userCompanyId: id(1), outcome: 'created', requestId: 'req_A', selfServeUrl: null },
    { userCompanyId: id(2), outcome: 'existing', requestId: 'req_B', selfServeUrl: null },
    { userCompanyId: id(3), outcome: 'use_form', requestId: 'req_C', selfServeUrl: 'https://examplo3.example/form' },
    { userCompanyId: id(4), outcome: 'kept', requestId: null, selfServeUrl: null },
    { userCompanyId: id(5), outcome: 'blocked', reason: 'must_keep', requestId: null, selfServeUrl: null },
    { userCompanyId: id(6), outcome: 'blocked', reason: 'no_contact', requestId: null, selfServeUrl: null },
  ];

  it('drafts the selected companies and explains each outcome in the app’s own words', async () => {
    const list = [1, 2, 3, 4, 5, 6].map((n) => company(n));
    const { api } = renderApp(<OverviewScreen />, { ...base(list), 'POST /v1/requests/drafts': { body: { results: outcomes } } });
    for (const n of [1, 2, 3, 4, 5, 6]) await userEvent.click(await screen.findByRole('checkbox', { name: copy.overview.company.select(`Examplo ${n}`) }));
    await userEvent.click(screen.getByRole('button', { name: copy.overview.draft.action(6) }));
    await screen.findByText(copy.overview.draft.resultsTitle);
    expect((api.calls('POST /v1/requests/drafts')[0]?.body as { userCompanyIds: string[] }).userCompanyIds).toHaveLength(6);
    const text = document.body.textContent ?? '';
    expect(text).toContain(copy.overview.draft.created);
    expect(text).toContain(copy.overview.draft.existing);
    expect(text).toContain(copy.overview.draft.useForm('Examplo 3'));
    expect(text).toContain(ERROR_MESSAGES.kept);
    expect(text).toContain(ERROR_MESSAGES.must_keep);
    expect(text).toContain(ERROR_MESSAGES.no_contact);
    expect(screen.getByRole('link', { name: copy.overview.draft.review }).getAttribute('href')).toBe('/requests/review');
    await userEvent.click(screen.getByRole('button', { name: copy.overview.draft.dismiss }));
    expect(screen.queryByText(copy.overview.draft.resultsTitle)).toBeNull();
  });

  it('shows the error if drafting fails', async () => {
    renderApp(<OverviewScreen />, { ...base([company(1)]), 'POST /v1/requests/drafts': problem(429, 'rate_limited') });
    await userEvent.click(await screen.findByRole('checkbox', { name: copy.overview.company.select('Examplo 1') }));
    await userEvent.click(screen.getByRole('button', { name: copy.overview.draft.action(1) }));
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_MESSAGES.rate_limited);
  });
});

describe('Overview: disabled rows, Keep helper text and category labels', () => {
  it.each([
    ['a must-keep company', { mustKeep: true }, copy.overview.company.reasonMustKeep],
    ['a kept company', { kept: true }, copy.overview.company.reasonKept],
  ])('%s: the checkbox looks disabled, says why, and cannot be ticked by click or keyboard', async (_name, over, reason) => {
    renderApp(<OverviewScreen />, base([company(1, over)]));
    const box = (await screen.findByRole('checkbox', { name: copy.overview.company.select('Examplo 1') })) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute('title')).toBe(reason);
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(box.getAttribute('aria-describedby') as string)?.textContent).toBe(reason);
    await userEvent.click(box);
    expect(box.checked).toBe(false);
    box.focus();
    await userEvent.keyboard(' ');
    expect(box.checked).toBe(false);
    expect(document.activeElement).not.toBe(box); // a disabled input is skipped by Tab as well
    expect(screen.queryByRole('button', { name: /Draft \d/ })).toBeNull();
  });

  it('an ordinary company has no reason text and can be ticked by keyboard', async () => {
    renderApp(<OverviewScreen />, base([company(1)]));
    const box = (await screen.findByRole('checkbox', { name: copy.overview.company.select('Examplo 1') })) as HTMLInputElement;
    expect(box.getAttribute('aria-describedby')).toBeNull();
    box.focus();
    await userEvent.keyboard(' ');
    expect(box.checked).toBe(true);
  });

  it('shows the Keep helper text only while the switch is on', async () => {
    renderApp(<OverviewScreen />, base([company(1), company(2, { kept: true })]));
    await screen.findByText('Examplo 1');
    const switches = screen.getAllByRole('switch');
    expect(switches.map((x) => x.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(screen.getAllByText(copy.overview.company.keepNote)).toHaveLength(1);
    expect(screen.getAllByText(copy.overview.company.keepLabel)).toHaveLength(2);
  });

  it('labels the new categories and keeps the others', async () => {
    renderApp(<OverviewScreen />, base([company(1, { category: 'account_provider', mustKeep: true }), company(2, { category: 'games' }), company(3, { category: 'saas' }), company(4, { category: 'other' })]));
    await screen.findByText('Examplo 1');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Account provider');
    expect(text).toContain('Games');
    expect(text).toContain('Software');
    expect(text).toContain('Other');
  });

  it('shows a plain fallback for a category this version does not know', async () => {
    renderApp(<OverviewScreen />, base([company(1, { category: 'banking' })]));
    expect(await screen.findByText(/examplo1\.example · Other/)).toBeTruthy();
  });
});
