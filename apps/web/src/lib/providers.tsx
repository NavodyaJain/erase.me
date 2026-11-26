'use client';

import { createApiClient, isApiError, type ApiClient } from '@erase/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { API_URL } from './config';
import { DeletedNoticeProvider } from './deletion';

const ApiContext = createContext<ApiClient | null>(null);

/** The typed API client. The only way the app talks to the API: there is no hand-written fetch. */
export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error('useApi must be used inside <AppProviders>');
  return client;
}

/** Server state defaults: a 4xx answer is a real answer, not something to retry. */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        retry: (count, error) => !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
  });
}

/** Tests pass their own client and query client. In the app both are created once. */
export function AppProviders({ children, client, queryClient }: { children: ReactNode; client?: ApiClient; queryClient?: QueryClient }) {
  const [api] = useState(() => client ?? createApiClient({ baseUrl: API_URL }));
  const [queries] = useState(() => queryClient ?? makeQueryClient());
  return (
    <ApiContext.Provider value={api}>
      <QueryClientProvider client={queries}>
        <DeletedNoticeProvider>{children}</DeletedNoticeProvider>
      </QueryClientProvider>
    </ApiContext.Provider>
  );
}
