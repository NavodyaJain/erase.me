'use client';

import { isDeletionPending, isUndoWindowClosed } from '@erase/api-client';
import type { AccountDeletion } from '@erase/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useApi } from './providers';
import { clearLocalState } from './session';

/** The signed-out confirmation after "Delete now" needs what the API answered. Held in memory only: never stored. */
const DeletedContext = createContext<{ notice: AccountDeletion | null; setNotice: (n: AccountDeletion | null) => void }>({ notice: null, setNotice: () => undefined });

export function DeletedNoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<AccountDeletion | null>(null);
  return <DeletedContext.Provider value={{ notice, setNotice }}>{children}</DeletedContext.Provider>;
}

export const useDeletedNotice = () => useContext(DeletedContext);

/** Where "Delete my data" stands. */
export function useDeletion(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: ['deletion'], queryFn: () => api.account.deletion(), enabled });
}

/** True once deletion has been asked for: the account is paused and only the "Your data" screen works. */
export const isPaused = (d: AccountDeletion | undefined): boolean => d !== undefined && d.status !== 'active';

/** If any call is refused because deletion is pending (asked for on another device, say), look at where it stands again. */
export function useDeletionWatch() {
  const queries = useQueryClient();
  useEffect(() => {
    const check = (event: { type: string; action?: { type: string; error?: unknown } }) => {
      if (event.type === 'updated' && event.action?.type === 'error' && isDeletionPending(event.action.error)) {
        void queries.invalidateQueries({ queryKey: ['deletion'] });
      }
    };
    const stopQueries = queries.getQueryCache().subscribe(check);
    const stopMutations = queries.getMutationCache().subscribe(check);
    return () => {
      stopQueries();
      stopMutations();
    };
  }, [queries]);
}

/** Everything except who is signed in and where deletion stands. A paused account may not read it, so it is not kept. */
const isAccountData = (key: readonly unknown[]): boolean => key[0] !== 'me' && key[0] !== 'deletion';

export function useRequestDeletion() {
  const api = useApi();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: () => api.account.requestDeletion(),
    onSuccess: (result) => {
      queries.setQueryData(['deletion'], result);
      queries.removeQueries({ predicate: (q) => isAccountData(q.queryKey) });
    },
  });
}

export function useUndoDeletion() {
  const api = useApi();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: () => api.account.undoDeletion(),
    onSuccess: (result) => {
      queries.setQueryData(['deletion'], result);
      void queries.invalidateQueries({ predicate: (q) => isAccountData(q.queryKey) });
    },
    onError: (error) => {
      if (isUndoWindowClosed(error)) void queries.invalidateQueries({ queryKey: ['deletion'] });
    },
  });
}

/** Deletes now. Every session ends, so what this device holds is cleared and the signed-out confirmation is shown. */
export function useDeleteNow() {
  const api = useApi();
  const queries = useQueryClient();
  const router = useRouter();
  const { setNotice } = useDeletedNotice();
  return useMutation({
    mutationFn: () => api.account.deleteNow(),
    onSuccess: async (result) => {
      setNotice(result);
      router.replace('/deleted');
      queries.clear();
      await clearLocalState();
    },
  });
}
