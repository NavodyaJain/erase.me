import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/AppShell';
import { AuthGate } from '@/components/AuthGate';
import { ErrorNotice } from '@/components/ErrorNotice';
import { resolveApiUrl } from '@/lib/config';
import { clearLocalState, STORAGE_PREFIX } from '@/lib/session';
import { ApiError } from '@erase/api-client';
import { ERROR_MESSAGES } from '@/copy/errors';
import { nav, resetNav } from './navigation';
import { ME, problem, renderApp } from './helpers';

describe('AppShell', () => {
  it('lists only the screens Phase 1 builds, marks the current one, and has a skip link', async () => {
    resetNav('/requests/review');
    const { container } = renderApp(
      <AppShell>
        <h1>Requests</h1>
      </AppShell>,
    );
    const links = screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual(expect.arrayContaining([['Skip to content', '#main'], ['Overview', '/overview'], ['Requests', '/requests'], ['Inboxes', '/connect']]));
    expect(screen.queryByText(/Money|Exposure|Aliases|Registry/)).toBeNull(); // deferred features have no entry
    expect(screen.getByRole('link', { name: 'Requests' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('signs out through the API, then returns to the sign-in screen', async () => {
    const { api } = renderApp(<AppShell>content</AppShell>, { 'POST /v1/auth/logout': { status: 204 } });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/'));
    expect(api.calls('POST /v1/auth/logout')).toHaveLength(1);
  });
});

describe('AuthGate', () => {
  it('shows a loading state, then the content for a signed-in user', async () => {
    renderApp(
      <AuthGate>
        <p>Signed-in content</p>
      </AuthGate>,
    );
    expect(screen.getByRole('status').textContent).toMatch(/Loading/);
    expect(await screen.findByText('Signed-in content')).toBeTruthy();
  });

  it('sends a signed-out visitor to sign in, without showing the content', async () => {
    renderApp(
      <AuthGate>
        <p>Signed-in content</p>
      </AuthGate>,
      { 'GET /v1/me': problem(401, 'unauthorized') },
    );
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/'));
    expect(screen.queryByText('Signed-in content')).toBeNull();
  });

  it('offers a retry when the server is down, and recovers', async () => {
    let up = false;
    renderApp(
      <AuthGate>
        <p>Signed-in content</p>
      </AuthGate>,
      { 'GET /v1/me': () => (up ? { body: ME } : problem(503, 'not_ready')) },
    );
    expect((await screen.findByRole('alert')).textContent).toBe(ERROR_MESSAGES.not_ready);
    expect(nav.replace).not.toHaveBeenCalled();
    up = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Signed-in content')).toBeTruthy();
  });
});

describe('ErrorNotice', () => {
  it('shows our message for the code, as an alert, and no server text', () => {
    renderApp(<ErrorNotice error={new ApiError(409, 'draft_changed', 'T', 'Server sentence', undefined, {})} />);
    expect(screen.getByRole('alert').textContent).toBe(ERROR_MESSAGES.draft_changed);
    expect(screen.queryByText('Server sentence')).toBeNull();
  });

  it('is a warning, not an error, when the result of a send is not known', () => {
    renderApp(<ErrorNotice error={new ApiError(502, 'send_outcome_unknown', 'T', undefined, undefined, {})} />);
    expect(document.querySelector('.ui-alert-warn')).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/Sent folder in Gmail/);
  });

  it('offers retry only when asked', async () => {
    const onRetry = vi.fn();
    const { rerender } = renderApp(<ErrorNotice error={new Error('x')} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ErrorNotice error={new Error('x')} />);
  });
});

describe('API address', () => {
  it('comes from NEXT_PUBLIC_API_URL, and a production build without it fails', () => {
    expect(resolveApiUrl({ NEXT_PUBLIC_API_URL: 'https://api.example.com/', NODE_ENV: 'production' })).toBe('https://api.example.com');
    expect(resolveApiUrl({ NEXT_PUBLIC_API_URL: 'http://localhost:4100', NODE_ENV: 'development' })).toBe('http://localhost:4100');
    expect(resolveApiUrl({ NODE_ENV: 'development' })).toBe('http://localhost:4000');
    expect(() => resolveApiUrl({ NODE_ENV: 'production' })).toThrow(/NEXT_PUBLIC_API_URL/);
    expect(() => resolveApiUrl({ NEXT_PUBLIC_API_URL: 'not a url', NODE_ENV: 'production' })).toThrow();
  });
});

describe('clearing local state on sign-out (F14-AC3)', () => {
  it('removes only this app’s keys, asks the service worker to drop its caches, and deletes Cache Storage', async () => {
    const store: Record<string, string> = { [`${STORAGE_PREFIX}hint`]: '1', [`${STORAGE_PREFIX}other`]: '2', unrelated: '3' };
    const storage = {
      removeItem: (k: string) => {
        delete store[k];
      },
    } as unknown as Storage;
    // Storage keys are enumerated with Object.keys: make the fake enumerable.
    for (const k of Object.keys(store)) Object.defineProperty(storage, k, { get: () => store[k], enumerable: true, configurable: true });
    const message = vi.fn();
    const deleted: string[] = [];
    const caches = { keys: () => Promise.resolve(['erase-shell-v1', 'erase-static-v1']), delete: (k: string) => (deleted.push(k), Promise.resolve(true)) } as unknown as CacheStorage;

    await clearLocalState({ storage, session: { removeItem: vi.fn() } as unknown as Storage, caches, worker: { postMessage: message } });

    expect(Object.keys(store)).toEqual(['unrelated']);
    expect(message).toHaveBeenCalledWith({ type: 'CLEAR_CACHES' });
    expect(deleted.sort()).toEqual(['erase-shell-v1', 'erase-static-v1']);
  });
});
