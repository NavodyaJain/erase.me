'use client';

import { createIdempotencyKey, isApiError, isStaleDraft } from '@erase/api-client';
import type { CompanyItem, RequestView } from '@erase/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
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
    onSuccess: async (started, inboxId) => {
      // The screen asks for the latest scan at the same moment it starts the first one. If that question was answered
      // "none" before the scan existed and the answer is still on its way, a plain invalidate would reuse that stale
      // in-flight request (a first fetch has no data to replace, so it is shared, not repeated), and the screen would
      // never learn about the scan. So drop the stale request, put the scan we were just given in its place (which also
      // starts the polling) and then ask again.
      await queries.cancelQueries({ queryKey: ['scan', inboxId] });
      queries.setQueryData(['scan', inboxId], started.scan);
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

export function useRequest(id: string) {
  const api = useApi();
  return useQuery({ queryKey: ['request', id], queryFn: () => api.requests.get(id) });
}

function useRefreshRequest() {
  const queries = useQueryClient();
  return (id: string, view?: RequestView) => {
    if (view) queries.setQueryData(['request', id], view);
    else void queries.invalidateQueries({ queryKey: ['request', id] });
    void queries.invalidateQueries({ queryKey: ['requests'] });
    void queries.invalidateQueries({ queryKey: ['companies'] });
  };
}

export function useEditDraft(id: string) {
  const api = useApi();
  const refresh = useRefreshRequest();
  return useMutation({
    mutationFn: (input: { baseHash: string; subject: string; body: string }) => api.requests.editDraft(id, input),
    onSuccess: (view) => refresh(id, view),
    onError: (e) => {
      if (isStaleDraft(e)) refresh(id);
    },
  });
}

export function useCloseRequest(id: string) {
  const api = useApi();
  const refresh = useRefreshRequest();
  return useMutation({ mutationFn: () => api.requests.close(id), onSuccess: (view) => refresh(id, view) });
}

export type StepResult =
  | { state: 'sent'; delivery: 'fake' | 'real' }
  | { state: 'approved' }
  | { state: 'stale' }
  | { state: 'error'; error: unknown };

/**
 * Approve (the exact draft version the person opened) and then send. Rules:
 * - approve uses `viewedHash`, never the latest hash;
 * - a changed draft (`draft_changed`) stops there: the request is refreshed and nothing is retried;
 * - one Idempotency-Key is made per request and reused on every retry, so a retry cannot send twice.
 */
export function useApproveAndSend() {
  const api = useApi();
  const refresh = useRefreshRequest();
  const keys = useRef(new Map<string, string>());
  return async (id: string, input: { viewedHash: string; alreadyApproved: boolean }): Promise<StepResult> => {
    try {
      if (!input.alreadyApproved) await api.requests.approve(id, input.viewedHash);
    } catch (error) {
      if (isStaleDraft(error)) {
        refresh(id);
        return { state: 'stale' };
      }
      refresh(id);
      return { state: 'error', error };
    }
    let key = keys.current.get(id);
    if (!key) {
      key = createIdempotencyKey();
      keys.current.set(id, key);
    }
    try {
      const sent = await api.requests.send(id, key);
      keys.current.delete(id);
      refresh(id);
      return { state: 'sent', delivery: sent.delivery };
    } catch (error) {
      // The key stays, so pressing "try again" reuses it.
      refresh(id);
      return { state: 'error', error };
    }
  };
}
