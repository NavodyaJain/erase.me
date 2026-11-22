import { createApiClient } from '@erase/api-client';
import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AppProviders } from '@/lib/providers';

/** A fake API for tests: records every request, answers from a table. No network, no real server. */
export interface Recorded {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  credentials: RequestCredentials;
  body: unknown;
}
export interface Answer {
  status?: number;
  body?: unknown;
  problem?: boolean;
}
type Handler = Answer | ((r: Recorded, n: number) => Answer | Promise<Answer>);

export function fakeApi(routes: Record<string, Handler> = {}) {
  const requests: Recorded[] = [];
  const counts = new Map<string, number>();
  const table = { ...routes };
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.text();
    const recorded: Recorded = { method: request.method, path: url.pathname, search: url.search, headers: request.headers, credentials: request.credentials, body: text ? (JSON.parse(text) as unknown) : undefined };
    requests.push(recorded);
    const key = `${request.method} ${url.pathname}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const handler = table[key];
    if (!handler) return new Response(JSON.stringify({ title: 'Not found', code: 'not_found', status: 404 }), { status: 404, headers: { 'content-type': 'application/problem+json' } });
    const answer = typeof handler === 'function' ? await handler(recorded, n) : handler;
    const status = answer.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(answer.body ?? {}), { status, headers: { 'content-type': answer.problem ? 'application/problem+json' : 'application/json' } });
  };
  return {
    fetch,
    requests,
    set: (key: string, handler: Handler) => {
      table[key] = handler;
    },
    calls: (key: string) => requests.filter((r) => `${r.method} ${r.path}` === key),
  };
}

export const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Answer => ({
  status,
  problem: true,
  body: { type: `urn:erase:problem:${code}`, title: 'Problem', status, code, detail: 'A server sentence that the app must not show.', instance: '/v1/x', requestId: 'req-1', ...extra },
});

export const ME = { id: 'usr_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA', email: 'asha@example.com', name: 'Asha Rao', csrfToken: 'csrf-token-1' };

/** Renders with the real providers, the real typed client, and a fake server behind it. */
export function renderApp(ui: ReactElement, routes: Record<string, Handler> = {}) {
  const api = fakeApi({ 'GET /v1/me': { body: ME }, ...routes });
  const client = createApiClient({ baseUrl: 'http://localhost:4000', fetch: api.fetch });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 }, mutations: { retry: false } } });
  const view = render(
    <AppProviders client={client} queryClient={queryClient}>
      {ui}
    </AppProviders>,
  );
  return { ...view, api, client, queryClient };
}
