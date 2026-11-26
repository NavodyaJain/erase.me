import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { AppShell } from '@/components/AppShell';
import { AuthGate } from '@/components/AuthGate';
import { DeletedScreen } from '@/components/DeletedScreen';
import { RequestsList } from '@/components/RequestsList';
import { GOOGLE_PERMISSIONS_URL, YourDataScreen } from '@/components/YourDataScreen';
import { copy } from '@/copy/en';
import { ERROR_MESSAGES } from '@/copy/errors';
import { findViolations } from './banned';
import { problem, renderApp } from './helpers';
import { nav, resetNav } from './navigation';

const y = copy.yourData;
const state = (status: 'active' | 'deleting' | 'deleted', over: Record<string, unknown> = {}) => ({
  status,
  requestedAt: status === 'active' ? null : '2026-11-22T10:00:00.000Z',
  deleteAfter: status === 'active' ? null : '2026-11-29T10:00:00.000Z',
  canUndo: status === 'deleting',
  paused: status !== 'active',
  googleAccess: { notRevoked: 0, message: null },
  gmailCopies: 'server words',
  notice: 'server words',
  ...over,
});
const at = (s: ReturnType<typeof state>) => ({ 'GET /v1/me/deletion': { body: s } });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const clean = async (container: HTMLElement) => {
  expect(findViolations(container.textContent ?? '')).toEqual([]);
  expect(container.textContent).not.toContain('server words');
  expect((await axe(container)).violations).toEqual([]);
};

describe('before deleting', () => {
  it('says what is held, what deleting does, and that Gmail copies are untouched', async () => {
    const { container } = renderApp(<YourDataScreen />, at(state('active')));
    expect(await screen.findByText(y.gmailCopies)).toBeTruthy();
    for (const line of [...y.holds, ...y.deleteSteps, y.sentRequests]) expect(screen.getByText(line)).toBeTruthy();
    await clean(container);
  });

  it('asks for confirmation, and cancelling asks the API for nothing', async () => {
    const { api } = renderApp(<YourDataScreen />, at(state('active')));
    await userEvent.click(await screen.findByRole('button', { name: y.deleteTitle }));
    expect(screen.getByText(y.confirmBody)).toBeTruthy();
    await userEvent.click(button(copy.common.cancel));
    expect(screen.queryByText(y.confirmBody)).toBeNull();
    expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('starts deletion with the CSRF token and shows the paused state with its date', async () => {
    const { api, container } = renderApp(<YourDataScreen />, { ...at(state('active')), 'DELETE /v1/me': { status: 202, body: state('deleting') } });
    await userEvent.click(await screen.findByRole('button', { name: y.deleteTitle }));
    await userEvent.click(button(y.confirmAction));
    expect(await screen.findByText(y.deleteOn('29 Nov 2026'))).toBeTruthy();
    expect(screen.getByText(y.paused)).toBeTruthy();
    expect(screen.getByText(y.gmailCopies)).toBeTruthy();
    expect(api.calls('DELETE /v1/me')[0]?.headers.get('x-csrf-token')).toBe('csrf-token-1');
    await clean(container);
  });
});

describe('while deletion is pending', () => {
  it('offers Undo and, only after a tick, Delete now', async () => {
    renderApp(<YourDataScreen />, at(state('deleting')));
    expect(await screen.findByRole('button', { name: y.undo })).toBeTruthy();
    expect(screen.getByText(y.undoNote)).toBeTruthy();
    expect(button(y.nowAction).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: y.nowConfirm }));
    expect(button(y.nowAction).disabled).toBe(false);
    expect(screen.queryByText(y.googleTitle)).toBeNull();
  });

  it('tells the person to remove access in Google when a revoke was not confirmed', async () => {
    const { container } = renderApp(<YourDataScreen />, at(state('deleting', { googleAccess: { notRevoked: 2, message: 'server words' } })));
    expect(await screen.findByText(y.googleBody(2))).toBeTruthy();
    const link = screen.getByRole('link', { name: y.googleLink });
    expect(link.getAttribute('href')).toBe(GOOGLE_PERMISSIONS_URL);
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    await clean(container);
  });

  it('Undo restores the account and asks the person to reconnect their inboxes', async () => {
    const { api } = renderApp(<YourDataScreen />, { ...at(state('deleting')), 'POST /v1/me/deletion/undo': { body: state('active') } });
    await userEvent.click(await screen.findByRole('button', { name: y.undo }));
    expect(await screen.findByText(y.undoneBody)).toBeTruthy();
    expect(screen.getByRole('link', { name: y.undoneAction }).getAttribute('href')).toBe('/connect');
    expect(api.calls('POST /v1/me/deletion/undo')).toHaveLength(1);
  });

  it('when the undo period has just ended, says so and removes Undo', async () => {
    const { api } = renderApp(<YourDataScreen />, {
      ...at(state('deleting')),
      'POST /v1/me/deletion/undo': () => {
        api.set('GET /v1/me/deletion', { body: state('deleting', { canUndo: false }) });
        return problem(409, 'undo_window_closed');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: y.undo }));
    expect(await screen.findByText(y.finishing)).toBeTruthy();
    expect(screen.queryByRole('button', { name: y.undo })).toBeNull();
    expect(screen.queryByRole('button', { name: y.nowAction })).toBeNull();
  });

  it('offers nothing to undo once the period is over', async () => {
    renderApp(<YourDataScreen />, at(state('deleting', { canUndo: false })));
    expect(await screen.findByText(y.finishing)).toBeTruthy();
    expect(screen.queryByRole('button', { name: y.undo })).toBeNull();
  });

  it('shows our message when a call fails', async () => {
    renderApp(<YourDataScreen />, { ...at(state('deleting')), 'POST /v1/me/deletion/now': problem(503, 'not_ready') });
    await userEvent.click(await screen.findByRole('checkbox', { name: y.nowConfirm }));
    await userEvent.click(button(y.nowAction));
    expect(await screen.findByText(ERROR_MESSAGES.not_ready)).toBeTruthy();
  });
});

describe('Delete now', () => {
  it('clears what this device holds, moves to the signed-out screen, and stores nothing about the person', async () => {
    resetNav('/your-data');
    window.localStorage.setItem('erase.hint', 'x');
    const deleted = state('deleted', { canUndo: false, googleAccess: { notRevoked: 1, message: 'server words' } });
    // Both screens under one set of providers, as in the app, where the notice is held in memory between them.
    const { api, queryClient } = renderApp(
      <>
        <YourDataScreen />
        <DeletedScreen />
      </>,
      { ...at(state('deleting')), 'POST /v1/me/deletion/now': { body: deleted } },
    );
    await userEvent.click(await screen.findByRole('checkbox', { name: y.nowConfirm }));
    await userEvent.click(button(y.nowAction));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/deleted'));
    expect(await screen.findByRole('heading', { name: y.deletedTitle })).toBeTruthy();
    expect(screen.getAllByText(y.googleBody(1)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(y.gmailCopies).length).toBeGreaterThan(0);
    expect(api.calls('POST /v1/me/deletion/now')[0]?.headers.get('x-csrf-token')).toBe('csrf-token-1');
    expect(window.localStorage.getItem('erase.hint')).toBeNull();
    expect(Object.keys(window.localStorage)).toEqual([]);
    expect(Object.keys(window.sessionStorage)).toEqual([]);
    expect(queryClient.getQueryData(['requests'])).toBeUndefined();
  });

  it('the signed-out screen opened on its own knows nothing about anyone', async () => {
    const { container } = renderApp(<DeletedScreen />);
    expect(screen.getByRole('heading', { name: y.signedOutTitle })).toBeTruthy();
    expect(screen.queryByText(y.googleTitle)).toBeNull();
    expect(screen.getByRole('link', { name: y.home }).getAttribute('href')).toBe('/');
    await clean(container);
  });
});

describe('routing while paused', () => {
  const gate = () => (
    <AuthGate>
      <p>Signed-in content</p>
    </AuthGate>
  );

  it('sends a pending person from any screen to "Your data", without showing that screen', async () => {
    resetNav('/overview');
    renderApp(gate(), at(state('deleting')));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/your-data'));
    expect(screen.queryByText('Signed-in content')).toBeNull();
  });

  it('shows "Your data" itself to a pending person, and every screen to an active one', async () => {
    resetNav('/your-data');
    const a = renderApp(gate(), at(state('deleting')));
    expect(await screen.findByText('Signed-in content')).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
    a.unmount();
    resetNav('/requests');
    renderApp(gate(), at(state('active')));
    expect(await screen.findByText('Signed-in content')).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('notices deletion_pending from any call, asked for on another device, and moves there', async () => {
    resetNav('/requests');
    const { api } = renderApp(
      <AuthGate>
        <RequestsList />
      </AuthGate>,
      {
        ...at(state('active')),
        'GET /v1/requests': () => {
          api.set('GET /v1/me/deletion', { body: state('deleting') });
          return problem(403, 'deletion_pending');
        },
      },
    );
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/your-data'));
  });

  it('does not lock anyone out if where deletion stands cannot be read', async () => {
    renderApp(gate(), { 'GET /v1/me/deletion': problem(503, 'not_ready') });
    expect(await screen.findByText('Signed-in content')).toBeTruthy();
  });

  it('the navigation shows only "Your data" while paused, and includes it otherwise', async () => {
    resetNav('/your-data');
    const paused = renderApp(<AppShell>content</AppShell>, at(state('deleting')));
    await waitFor(() => expect(screen.queryByRole('link', { name: copy.nav.requests })).toBeNull());
    expect(screen.getByRole('link', { name: copy.nav.yourData }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: copy.common.signOut })).toBeTruthy();
    paused.unmount();
    renderApp(<AppShell>content</AppShell>, at(state('active')));
    expect(await screen.findByRole('link', { name: copy.nav.requests })).toBeTruthy();
    expect(screen.getByRole('link', { name: copy.nav.yourData }).getAttribute('href')).toBe('/your-data');
  });
});
