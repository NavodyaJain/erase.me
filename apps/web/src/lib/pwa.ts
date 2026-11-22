import { STORAGE_PREFIX } from './session';

/** The only thing the install hint stores: when it was last shown. Not personal data; cleared on sign-out. */
export const INSTALL_HINT_KEY = `${STORAGE_PREFIX}install-hint-at`;
export const INSTALL_HINT_EVERY_MS = 30 * 24 * 60 * 60 * 1000;

/** iPhone and iPad have no install prompt, so the app explains "Share, then Add to Home Screen" instead. */
export const isIos = (userAgent: string, maxTouchPoints = 0): boolean => /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);

/** A browser that is not Safari on iOS (Chrome, Firefox and so on) cannot add to the home screen from there. */
export const isIosSafari = (userAgent: string): boolean => /Safari\//.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);

export interface HintInput {
  userAgent: string;
  maxTouchPoints?: number;
  standalone: boolean;
  /** Epoch ms when it was last shown, if ever. */
  lastShownAt: number | undefined;
  now: number;
}

/** Shown on iPhone Safari only, not when already installed, and at most once every 30 days (F14). */
export function shouldShowInstallHint(i: HintInput): boolean {
  if (i.standalone || !isIos(i.userAgent, i.maxTouchPoints) || !isIosSafari(i.userAgent)) return false;
  return i.lastShownAt === undefined || i.now - i.lastShownAt >= INSTALL_HINT_EVERY_MS;
}

export const isStandalone = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function readLastShown(storage: Pick<Storage, 'getItem'>): number | undefined {
  try {
    const raw = storage.getItem(INSTALL_HINT_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export function markShown(storage: Pick<Storage, 'setItem'>, now: number): void {
  try {
    storage.setItem(INSTALL_HINT_KEY, String(now));
  } catch {
    // Storage can be blocked: the hint then simply shows again next time.
  }
}

/**
 * Calls `onWaiting` when a new service worker has installed and is waiting for the person to accept it. It never
 * skips waiting by itself: the update is applied only from the visible prompt (`applyUpdate`).
 */
export function watchForUpdate(registration: Pick<ServiceWorkerRegistration, 'waiting' | 'installing' | 'addEventListener'>, onWaiting: (worker: ServiceWorker) => void): void {
  if (registration.waiting) onWaiting(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) onWaiting(worker);
    });
  });
}

export function applyUpdate(worker: Pick<ServiceWorker, 'postMessage'>, reload: () => void): void {
  navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
  worker.postMessage({ type: 'SKIP_WAITING' });
}
