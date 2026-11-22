'use client';

import { isApiError } from '@erase/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from './providers';

/** Keys of everything the app writes to browser storage start with this, so sign-out can clear exactly those. */
export const STORAGE_PREFIX = 'erase.';

/**
 * Removes everything this app stored in the browser and asks the service worker to drop its caches (F14-AC3).
 * The app stores no personal data; this keeps it that way even if a key was written for a harmless reason.
 */
export async function clearLocalState(env: {
  storage?: Storage;
  session?: Storage;
  caches?: CacheStorage;
  worker?: { postMessage(message: unknown): void } | null;
} = {}): Promise<void> {
  const storages = [env.storage ?? safe(() => window.localStorage), env.session ?? safe(() => window.sessionStorage)];
  for (const s of storages) {
    if (!s) continue;
    for (const key of Object.keys(s)) if (key.startsWith(STORAGE_PREFIX)) s.removeItem(key);
  }
  const worker = env.worker ?? safe(() => navigator.serviceWorker?.controller) ?? null;
  worker?.postMessage({ type: 'CLEAR_CACHES' });
  const cacheStorage = env.caches ?? safe(() => window.caches);
  if (cacheStorage) await Promise.all((await cacheStorage.keys()).map((k) => cacheStorage.delete(k)));
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** The signed-in user. A 401 means signed out: that is an answer, not an error to retry. */
export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false, staleTime: 60_000 });
}

export const isSignedOut = (error: unknown): boolean => isApiError(error) && error.status === 401;

export function useSignOut() {
  const api = useApi();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await api.logout();
      } finally {
        queries.clear();
        await clearLocalState();
      }
    },
  });
}
