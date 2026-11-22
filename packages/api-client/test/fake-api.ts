/** A fake API for tests: records every request it gets and answers from a small table. No network. */
export interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  credentials: RequestCredentials;
  body: unknown;
}

export interface Answer {
  status?: number;
  body?: unknown;
  problem?: boolean;
}

type Handler = Answer | ((r: Recorded, n: number) => Answer);

export function fakeApi(routes: Record<string, Handler>) {
  const requests: Recorded[] = [];
  const counts = new Map<string, number>();
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    const recorded: Recorded = {
      method: request.method,
      path: url.pathname,
      headers: request.headers,
      credentials: request.credentials,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
    requests.push(recorded);
    const key = `${request.method} ${url.pathname}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ title: 'Not found', code: 'not_found', status: 404 }), { status: 404, headers: { 'content-type': 'application/problem+json' } });
    const answer = typeof handler === 'function' ? handler(recorded, n) : handler;
    const status = answer.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(answer.body ?? {}), {
      status,
      headers: { 'content-type': answer.problem ? 'application/problem+json' : 'application/json' },
    });
  };
  return { fetch, requests, calls: (key: string) => requests.filter((r) => `${r.method} ${r.path}` === key) };
}

export const problem = (status: number, code: string, title: string, extra: Record<string, unknown> = {}): Answer => ({
  status,
  problem: true,
  body: { type: `urn:erase:problem:${code}`, title, status, code, detail: `${title}.`, instance: '/v1/example', requestId: 'req-id-1', ...extra },
});

export const ME = { id: 'usr_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA', email: 'asha@example.com', name: 'Asha Rao', csrfToken: 'csrf-token-1' };
export const REQUEST_ID = 'req_01J8Z3K9M2Q7R6T5V4W3X2Y1ZA';
