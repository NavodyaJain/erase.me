import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { ConnectScreen } from '@/components/ConnectScreen';
import { SignIn } from '@/components/SignIn';
import { AUTH_ERROR_MESSAGES, ERROR_MESSAGES } from '@/copy/errors';
import { copy } from '@/copy/en';
import { findViolations } from './banned';
import { nav, resetNav } from './navigation';
import { ME, problem, renderApp } from './helpers';

const INBOX = { id: 'inb_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA', email: 'asha.mail@example.com', status: 'connected', connectedAt: '2026-11-20T09:30:00.000Z', lastScanAt: '2026-11-21T09:30:00.000Z' };
const SCAN = (over: Record<string, unknown> = {}) => ({ scan: { id: 'scn_1', inboxId: INBOX.id, status: 'done', progressPct: 100, foundCount: 28, startedAt: null, finishedAt: null, errorCode: null, ...over } });
const scanKey = `GET /v1/inboxes/${INBOX.id}/scan`;

const setLocationAssign = () => {
  const assign = vi.fn();
  Object.defineProperty(window, 'location', { value: { ...window.location, assign }, configurable: true });
  return assign;
};

describe('sign-in entry', () => {
  it('shows the sign-in screen to a signed-out visitor, with the plain consent explanation', async () => {
    const { container } = renderApp(<SignIn />, { 'GET /v1/me': problem(401, 'unauthorized') });
    expect(await screen.findByRole('heading', { name: copy.signIn.title })).toBeTruthy();
    const link = screen.getByRole('link', { name: copy.signIn.button });
    expect(link.getAttribute('href')).toBe('http://localhost:4000/v1/auth/google/start');
    expect(screen.getByText(copy.signIn.shares)).toBeTruthy();
    expect(screen.getByText(copy.consent.later.body)).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each(Object.keys(AUTH_ERROR_MESSAGES))('explains a failed sign-in (%s)', async (reason) => {
    resetNav('/', `?auth_error=${reason}`);
    renderApp(<SignIn />, { 'GET /v1/me': problem(401, 'unauthorized') });
    expect(await screen.findByText(AUTH_ERROR_MESSAGES[reason] as string)).toBeTruthy();
    expect(screen.getByText(copy.signIn.errorTitle)).toBeTruthy();
  });

  it('gives a generic message for a reason it does not know, and never echoes it', async () => {
    resetNav('/', '?auth_error=%3Cscript%3Ex');
    renderApp(<SignIn />, { 'GET /v1/me': problem(401, 'unauthorized') });
    expect(await screen.findByText('Sign-in did not complete. Try again.')).toBeTruthy();
    expect(screen.queryByText(/script/)).toBeNull();
  });

  it('forwards a signed-in visitor to the overview, or back to Connect after connecting an inbox', async () => {
    renderApp(<SignIn />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/overview'));
    resetNav('/', '?inbox=connected');
    renderApp(<SignIn />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/connect?inbox=connected'));
  });

  it('offers retry when the server is down', async () => {
    renderApp(<SignIn />, { 'GET /v1/me': problem(503, 'not_ready') });
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_MESSAGES.not_ready);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offers an "open in browser" fallback inside the installed app', async () => {
    Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true }), configurable: true });
    renderApp(<SignIn />, { 'GET /v1/me': problem(401, 'unauthorized') });
    const fallback = await screen.findByRole('link', { name: copy.signIn.openInBrowser });
    expect(fallback.getAttribute('target')).toBe('_blank');
    expect(fallback.getAttribute('rel')).toMatch(/noopener/);
    Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false }), configurable: true });
  });
});

describe('Connect: consent before Google', () => {
  it('explains what is read (headers only) and what is used later (send, only after approval), and never calls it read-only', async () => {
    renderApp(<ConnectScreen />, { 'GET /v1/inboxes': { body: { inboxes: [] } } });
    await screen.findByText(copy.connect.empty);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Message headers');
    expect(text).toContain('We do not open message bodies or attachments');
    expect(text).toContain('Nothing is sent without your approval');
    expect(text).toContain('only after you review and approve a request');
    expect(text).not.toMatch(/read-only/i);
    expect(findViolations(text)).toEqual([]);
  });

  it('starts the connection and sends the browser to Google', async () => {
    const assign = setLocationAssign();
    const { api } = renderApp(<ConnectScreen />, {
      'GET /v1/inboxes': { body: { inboxes: [] } },
      'POST /v1/inboxes/connect/start': { body: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=example' } },
    });
    await userEvent.click(await screen.findByRole('button', { name: copy.connect.add }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=example'));
    const call = api.calls('POST /v1/inboxes/connect/start')[0];
    expect(call?.headers.get('x-csrf-token')).toBe(ME.csrfToken);
    expect(call?.credentials).toBe('include');
  });

  it('shows the inbox limit and lets the person try again', async () => {
    const { container } = renderApp(<ConnectScreen />, { 'GET /v1/inboxes': { body: { inboxes: [INBOX] } }, [scanKey]: { body: SCAN() }, 'POST /v1/inboxes/connect/start': problem(409, 'inbox_limit') });
    await userEvent.click(await screen.findByRole('button', { name: copy.connect.addAnother }));
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_MESSAGES.inbox_limit);
    expect(screen.getByRole('button', { name: copy.connect.addAnother })).toHaveProperty('disabled', false);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Connect: inboxes and scan progress', () => {
  it('lists an inbox with its finished scan, and lets the person continue to the overview', async () => {
    const { container } = renderApp(<ConnectScreen />, { 'GET /v1/inboxes': { body: { inboxes: [INBOX] } }, [scanKey]: { body: SCAN() } });
    expect(await screen.findByText(INBOX.email)).toBeTruthy();
    expect(await screen.findByText('Scan finished · 28 companies')).toBeTruthy();
    expect(screen.getByRole('link', { name: copy.connect.seeWhatWeFound }).getAttribute('href')).toBe('/overview');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows progress while scanning, polls until it finishes, and never blocks the page', async () => {
    let n = 0;
    renderApp(<ConnectScreen />, {
      'GET /v1/inboxes': { body: { inboxes: [INBOX] } },
      [scanKey]: () => ({ body: n++ === 0 ? SCAN({ status: 'running', progressPct: 40, foundCount: 12 }) : SCAN() }),
    });
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(screen.getByText(/12 companies so far/)).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.connect.addAnother })).toHaveProperty('disabled', false); // the page stays usable
    expect(await screen.findByText('Scan finished · 28 companies', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('explains a scan that did not finish, and a grant that Google no longer allows', async () => {
    const { queryClient, api } = renderApp(<ConnectScreen />, { 'GET /v1/inboxes': { body: { inboxes: [INBOX] } }, [scanKey]: { body: SCAN({ status: 'failed', errorCode: 'gmail_quota' }) } });
    expect(await screen.findByText(copy.connect.scanFailed)).toBeTruthy();
    api.set(scanKey, { body: SCAN({ status: 'failed', errorCode: 'gmail_auth' }) });
    await queryClient.invalidateQueries({ queryKey: ['scan', INBOX.id] });
    expect(await screen.findByText(copy.connect.needsReconnect)).toBeTruthy();
  });

  it('starts a scan from the button, and shows the right message when the inbox is not connected', async () => {
    const { api } = renderApp(<ConnectScreen />, { 'GET /v1/inboxes': { body: { inboxes: [INBOX] } }, [scanKey]: { body: SCAN() }, [`POST /v1/inboxes/${INBOX.id}/scan`]: problem(409, 'inbox_not_connected') });
    await userEvent.click(await screen.findByRole('button', { name: copy.connect.scanAgain }));
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_MESSAGES.inbox_not_connected);
    expect(api.calls(`POST /v1/inboxes/${INBOX.id}/scan`)).toHaveLength(1);
  });

  it('shows a loading state, then an error with retry if the list cannot load', async () => {
    renderApp(<ConnectScreen />, { 'GET /v1/inboxes': problem(503, 'not_ready') });
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_MESSAGES.not_ready);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('Connect: after Google sends the person back', () => {
  it('says so, and scans an inbox that has never been scanned, exactly once', async () => {
    resetNav('/connect', '?inbox=connected');
    const fresh = { ...INBOX, lastScanAt: null };
    const { api, queryClient } = renderApp(<ConnectScreen />, {
      'GET /v1/inboxes': { body: { inboxes: [fresh] } },
      [scanKey]: problem(404, 'not_found'),
      [`POST /v1/inboxes/${INBOX.id}/scan`]: { status: 202, body: SCAN({ status: 'queued', progressPct: 0, foundCount: 0 }) },
    });
    expect(await screen.findByText(copy.connect.connected)).toBeTruthy();
    await waitFor(() => expect(api.calls(`POST /v1/inboxes/${INBOX.id}/scan`)).toHaveLength(1));
    // The list is fetched again (as it is on focus or after a scan): the same inbox is not scanned twice.
    await queryClient.invalidateQueries({ queryKey: ['inboxes'] });
    await new Promise((r) => setTimeout(r, 100));
    expect(api.calls('GET /v1/inboxes').length).toBeGreaterThan(1);
    expect(api.calls(`POST /v1/inboxes/${INBOX.id}/scan`)).toHaveLength(1);
  });

  it('shows the scan even when the first "is there a scan?" answer (none) arrives after the scan was started', async () => {
    // The page asks for the latest scan at the same moment it starts the first one. If that question is answered "none"
    // by a server that had not created the scan yet, and the answer is still on its way when the start call returns,
    // the screen must still end up showing the scan (this once left it stuck on a plain Scan button).
    resetNav('/connect', '?inbox=connected');
    const fresh = { ...INBOX, lastScanAt: null };
    let reads = 0;
    const { api } = renderApp(<ConnectScreen />, {
      'GET /v1/inboxes': { body: { inboxes: [fresh] } },
      [scanKey]: async () => {
        reads += 1;
        if (reads === 1) {
          await new Promise((r) => setTimeout(r, 150)); // the slow, early "none"
          return problem(404, 'not_found');
        }
        return { body: SCAN({ status: 'done', progressPct: 100, foundCount: 4 }) };
      },
      [`POST /v1/inboxes/${INBOX.id}/scan`]: { status: 202, body: SCAN({ status: 'queued', progressPct: 0, foundCount: 0 }) },
    });
    expect(await screen.findByText('Scan finished · 4 companies')).toBeTruthy();
    expect(api.calls(`POST /v1/inboxes/${INBOX.id}/scan`)).toHaveLength(1);
  });

  it('says so when the automatic first scan could not be started', async () => {
    resetNav('/connect', '?inbox=connected');
    renderApp(<ConnectScreen />, {
      'GET /v1/inboxes': { body: { inboxes: [{ ...INBOX, lastScanAt: null }] } },
      [scanKey]: problem(404, 'not_found'),
      [`POST /v1/inboxes/${INBOX.id}/scan`]: problem(409, 'inbox_not_connected'),
    });
    expect(await screen.findByText(ERROR_MESSAGES.inbox_not_connected)).toBeTruthy();
  });

  it('does not scan an inbox that already has a scan', async () => {
    resetNav('/connect', '?inbox=connected');
    const { api } = renderApp(<ConnectScreen />, { 'GET /v1/inboxes': { body: { inboxes: [INBOX] } }, [scanKey]: { body: SCAN() } });
    await screen.findByText(copy.connect.connected);
    await screen.findByText(INBOX.email);
    expect(api.calls(`POST /v1/inboxes/${INBOX.id}/scan`)).toHaveLength(0);
  });
});

describe('Connect: disconnect', () => {
  it('asks first, and cancelling changes nothing', async () => {
    const { api } = renderApp(<ConnectScreen />, { 'GET /v1/inboxes': { body: { inboxes: [INBOX] } }, [scanKey]: { body: SCAN() } });
    await userEvent.click(await screen.findByRole('button', { name: `${copy.connect.disconnect} ${INBOX.email}` }));
    expect(screen.getByText(copy.connect.disconnectTitle)).toBeTruthy();
    expect(screen.getByText(copy.connect.disconnectBody)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: copy.common.cancel }));
    expect(screen.queryByText(copy.connect.disconnectTitle)).toBeNull();
    expect(api.calls(`DELETE /v1/inboxes/${INBOX.id}`)).toHaveLength(0);
  });

  it('disconnects, and warns when Google could not be reached to remove access', async () => {
    const { api } = renderApp(<ConnectScreen />, {
      'GET /v1/inboxes': { body: { inboxes: [INBOX] } },
      [scanKey]: { body: SCAN() },
      [`DELETE /v1/inboxes/${INBOX.id}`]: { body: { status: 'disconnected', revokedAtGoogle: false } },
    });
    await userEvent.click(await screen.findByRole('button', { name: `${copy.connect.disconnect} ${INBOX.email}` }));
    await userEvent.click(screen.getByRole('button', { name: copy.connect.disconnectConfirm }));
    expect(await screen.findByText(copy.connect.notRevoked)).toBeTruthy();
    expect(api.calls(`DELETE /v1/inboxes/${INBOX.id}`)[0]?.headers.get('x-csrf-token')).toBe(ME.csrfToken);
  });

  it('shows the error if disconnecting fails', async () => {
    renderApp(<ConnectScreen />, { 'GET /v1/inboxes': { body: { inboxes: [INBOX] } }, [scanKey]: { body: SCAN() }, [`DELETE /v1/inboxes/${INBOX.id}`]: problem(404, 'not_found') });
    await userEvent.click(await screen.findByRole('button', { name: `${copy.connect.disconnect} ${INBOX.email}` }));
    await userEvent.click(screen.getByRole('button', { name: copy.connect.disconnectConfirm }));
    const alerts = await screen.findAllByRole('alert');
    expect(within(alerts.at(-1) as HTMLElement).getByText(ERROR_MESSAGES.not_found)).toBeTruthy();
  });
});
