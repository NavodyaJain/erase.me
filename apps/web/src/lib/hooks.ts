'use client';

import { isApiError } from '@erase/api-client';
import type { CompanyItem } from '@erase/contracts';
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

export function useCompanies() {
  const api = useApi();
  return useQuery({ queryKey: ['companies'], queryFn: () => api.companies.list() });
}

export function useRequests() {
  const api = useApi();
  return useQuery({ queryKey: ['requests'], queryFn: () => api.requests.list() });
}

/**
 * "Keep this" on or off. A safe, easily undone change, so it is applied at once and rolled back if the server
 * refuses it (the only kind of optimistic update the app makes).
 */
export function useKeep() {
  const api = useApi();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: ({ id, kept }: { id: string; kept: boolean }) => (kept ? api.companies.keep(id) : api.companies.unkeep(id)),
    onMutate: async ({ id, kept }) => {
      await queries.cancelQueries({ queryKey: ['companies'] });
      const before = queries.getQueryData<CompanyItem[]>(['companies']);
      queries.setQueryData<CompanyItem[]>(['companies'], (list) => list?.map((c) => (c.id === id ? { ...c, kept } : c)));
      return { before };
    },
    onError: (_error, _vars, context) => {
      if (context?.before) queries.setQueryData(['companies'], context.before);
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: ['companies'] });
    },
  });
}

export function useCreateDrafts() {
  const api = useApi();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.requests.createDrafts(ids),
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: ['companies'] });
      void queries.invalidateQueries({ queryKey: ['requests'] });
    },
  });
}
