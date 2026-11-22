'use client';

import { isApiError } from '@erase/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from './providers';

export const SCAN_POLL_MS = 1500;

export const isScanActive = (status: string | undefined): boolean => status === 'queued' || status === 'running';

export function useInboxes() {
  const api = useApi();
  return useQuery({ queryKey: ['inboxes'], queryFn: () => api.inboxes.list() });
}

/** The latest scan of an inbox, or null if it has none yet. Polls while a scan is running (the page never blocks). */
export function useLatestScan(inboxId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['scan', inboxId],
    queryFn: async () => {
      try {
        return await api.inboxes.latestScan(inboxId);
      } catch (e) {
        if (isApiError(e) && e.status === 404) return null;
        throw e;
      }
    },
    refetchInterval: (query) => (isScanActive(query.state.data?.status) ? SCAN_POLL_MS : false),
  });
}

export function useStartScan() {
  const api = useApi();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (inboxId: string) => api.inboxes.startScan(inboxId),
    onSuccess: (_data, inboxId) => {
      void queries.invalidateQueries({ queryKey: ['scan', inboxId] });
      void queries.invalidateQueries({ queryKey: ['inboxes'] });
    },
  });
}

export function useDisconnectInbox() {
  const api = useApi();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (inboxId: string) => api.inboxes.disconnect(inboxId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['inboxes'] });
      void queries.invalidateQueries({ queryKey: ['companies'] });
    },
  });
}

/** Resolves to the Google consent URL. The caller shows the consent panel first, then navigates. */
export function useStartConnect() {
  const api = useApi();
  return useMutation({ mutationFn: () => api.inboxes.startConnect() });
}
