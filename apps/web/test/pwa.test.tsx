import { existsSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import OfflinePage from '@/app/offline/page';
import manifest from '@/app/manifest';
import { PwaChrome } from '@/components/PwaChrome';
import { copy } from '@/copy/en';
import { findViolations, stringsIn } from './banned';
import {
  applyUpdate,
  INSTALL_HINT_EVERY_MS,
  INSTALL_HINT_KEY,
  isIos,
  markShown,
  readLastShown,
  shouldShowInstallHint,
  watchForUpdate,
} from '@/lib/pwa';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const NOW = Date.UTC(2026, 10, 22);

describe('manifest (F14)', () => {
  const m = manifest();
  it('is a standalone app with the brand colours and start URL', () => {
    expect(m).toMatchObject({ name: 'Erase.me', short_name: 'Erase', display: 'standalone', start_url: '/', scope: '/', theme_color: '#2F55F4', background_color: '#F5F6F8' });
  });

  it('has 192, 512 and maskable icons, and each file comes from the shared brand assets', () => {
    const icons = m.icons ?? [];
    expect(icons.map((i) => [i.sizes, i.purpose])).toEqual([['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]);
    for (const icon of icons) {
      const file = path.resolve(__dirname, '../../../packages/ui/assets/brand', path.basename(icon.src));
      expect(existsSync(file), icon.src).toBe(true);
      expect(icon.src.startsWith('/brand/')).toBe(true);
    }
  });

  it('uses the accent colour from the tokens', async () => {
    const tokens = (await import('node:fs')).readFileSync(path.resolve(__dirname, '../../../packages/ui/tokens/tokens.css'), 'utf8');
    expect(tokens).toContain(`--color-accent: ${m.theme_color}`);
  });
});

describe('install hint rules', () => {
  const base = { userAgent: IPHONE_SAFARI, standalone: false, lastShownAt: undefined as number | undefined, now: NOW };

  it('shows on iPhone Safari the first time', () => {
    expect(shouldShowInstallHint(base)).toBe(true);
    expect(shouldShowInstallHint({ ...base, userAgent: IPAD_AS_MAC, maxTouchPoints: 5 })).toBe(true);
  });

  it('is not repeated within 30 days, and returns after', () => {
    expect(shouldShowInstallHint({ ...base, lastShownAt: NOW - INSTALL_HINT_EVERY_MS + 1000 })).toBe(false);
    expect(shouldShowInstallHint({ ...base, lastShownAt: NOW - INSTALL_HINT_EVERY_MS })).toBe(true);
  });

  it('is not shown when already installed, on Android, or in another browser on iPhone', () => {
    expect(shouldShowInstallHint({ ...base, standalone: true })).toBe(false);
    expect(shouldShowInstallHint({ ...base, userAgent: ANDROID })).toBe(false);
    expect(shouldShowInstallHint({ ...base, userAgent: IPHONE_CHROME })).toBe(false);
    expect(isIos(ANDROID)).toBe(false);
    expect(isIos(IPAD_AS_MAC, 0)).toBe(false);
  });

  it('keeps only a timestamp, and copes with storage that is blocked', () => {
    const store: Record<string, string> = {};
    const storage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) };
    expect(readLastShown(storage)).toBeUndefined();
    markShown(storage, NOW);
    expect(store).toEqual({ [INSTALL_HINT_KEY]: String(NOW) });
    expect(readLastShown(storage)).toBe(NOW);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readLastShown(blocked)).toBeUndefined();
    expect(() => markShown(blocked, NOW)).not.toThrow();
    expect(readLastShown({ getItem: () => 'not a number' })).toBeUndefined();
  });
});

describe('update prompt rules', () => {
  function fakeRegistration(initial: { waiting?: ServiceWorker | null } = {}) {
    const listeners: Record<string, () => void> = {};
    const stateListeners: Array<() => void> = [];
    const installing = { state: 'installing', addEventListener: (_t: string, fn: () => void) => stateListeners.push(fn), postMessage: vi.fn() } as unknown as ServiceWorker & { state: string };
    const registration = {
      waiting: initial.waiting ?? null,
      installing: null as ServiceWorker | null,
      addEventListener: (t: string, fn: () => void) => void (listeners[t] = fn),
    };
    return {
      registration: registration as unknown as ServiceWorkerRegistration,
      installing,
      foundUpdate: () => {
        registration.installing = installing;
        listeners.updatefound?.();
      },
      install: () => {
        (installing as { state: string }).state = 'installed';
        stateListeners.forEach((f) => f());
      },
    };
  }

  it('offers an update when a new worker is installed while one is in control, and never applies it by itself', () => {
    Object.defineProperty(navigator, 'serviceWorker', { value: { controller: {}, addEventListener: vi.fn() }, configurable: true });
    const f = fakeRegistration();
    const onWaiting = vi.fn();
    watchForUpdate(f.registration, onWaiting);
    expect(onWaiting).not.toHaveBeenCalled();
    f.foundUpdate();
    f.install();
    expect(onWaiting).toHaveBeenCalledWith(f.installing);
    expect(f.installing.postMessage).not.toHaveBeenCalled();
  });

  it('reports a worker that is already waiting, and says nothing on the very first install', () => {
    const waiting = {} as ServiceWorker;
    const onWaiting = vi.fn();
    watchForUpdate(fakeRegistration({ waiting }).registration, onWaiting);
    expect(onWaiting).toHaveBeenCalledWith(waiting);

    Object.defineProperty(navigator, 'serviceWorker', { value: { controller: null, addEventListener: vi.fn() }, configurable: true });
    const first = fakeRegistration();
    const quiet = vi.fn();
    watchForUpdate(first.registration, quiet);
    first.foundUpdate();
    first.install();
    expect(quiet).not.toHaveBeenCalled();
  });

  it('applies the update only on request: skip waiting, then reload when the new worker takes over', () => {
    const add = vi.fn((_t: string, fn: () => void) => fn());
    Object.defineProperty(navigator, 'serviceWorker', { value: { controller: {}, addEventListener: add }, configurable: true });
    const worker = { postMessage: vi.fn() };
    const reload = vi.fn();
    applyUpdate(worker, reload);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('PwaChrome', () => {
  const setUa = (ua: string) => Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  const matchMedia = (matches: boolean) => Object.defineProperty(window, 'matchMedia', { value: () => ({ matches }), configurable: true });

  it('shows the iPhone hint once, can be dismissed, and is not shown again straight away', async () => {
    window.localStorage.clear();
    setUa(IPHONE_SAFARI);
    matchMedia(false);
    const first = render(<PwaChrome />);
    expect(await screen.findByText(copy.pwa.installBody)).toBeTruthy();
    expect(window.localStorage.getItem(INSTALL_HINT_KEY)).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: copy.pwa.dismiss }));
    expect(screen.queryByText(copy.pwa.installBody)).toBeNull();
    first.unmount();
    render(<PwaChrome />);
    expect(screen.queryByText(copy.pwa.installBody)).toBeNull();
    window.localStorage.clear();
  });

  it('shows nothing in the installed app or on Android', () => {
    window.localStorage.clear();
    setUa(IPHONE_SAFARI);
    matchMedia(true);
    const installed = render(<PwaChrome />);
    expect(installed.container.textContent).toBe('');
    installed.unmount();
    setUa(ANDROID);
    matchMedia(false);
    expect(render(<PwaChrome />).container.textContent).toBe('');
  });
});

describe('offline page (F14-AC2)', () => {
  it('explains that a connection is needed, shows no personal data, and calls no API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { container } = render(<OfflinePage />);
    expect(screen.getByRole('heading', { name: copy.offline.title })).toBeTruthy();
    expect(screen.getByText(copy.offline.body)).toBeTruthy();
    expect(container.textContent).not.toMatch(/@|example\.com|\bucm_|\breq_/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('uses hedged, rule-abiding wording', () => {
    for (const s of stringsIn({ pwa: copy.pwa, offline: copy.offline })) expect(findViolations(s), s).toEqual([]);
  });
});
