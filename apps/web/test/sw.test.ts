import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Runs the real public/sw.js in a sandbox with fake caches and a fake network. The point of these tests is the
 * privacy rule: the worker caches the static shell only, and never an API response or a page.
 */

const code = readFileSync(path.resolve(__dirname, '../public/sw.js'), 'utf8');
const ORIGIN = 'https://app.example';
const OFFLINE_HTML = '<html><head><link rel="stylesheet" href="/_next/static/css/app.css"></head><body><script src="/_next/static/chunks/app.js"></script></body></html>';

const pathOf = (input: unknown): string => {
  const raw = typeof input === 'string' ? input : (input as { url: string }).url;
  return raw.startsWith('http') ? new URL(raw).pathname + new URL(raw).search : raw;
};

function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const writes: string[] = [];
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name) as Map<string, Response>;
    return Promise.resolve({
      match: (req: unknown) => Promise.resolve(store.get(pathOf(req))?.clone()),
      put: (req: unknown, res: Response) => {
        writes.push(pathOf(req));
        store.set(pathOf(req), res);
        return Promise.resolve();
      },
      add: async (req: unknown) => {
        const res = await network(pathOf(req));
        if (!res.ok) throw new Error('bad status');
        writes.push(pathOf(req));
        store.set(pathOf(req), res);
      },
      addAll: async (reqs: unknown[]) => {
        for (const r of reqs) {
          const res = await network(pathOf(r));
          if (!res.ok) throw new Error('bad status');
          writes.push(pathOf(r));
          store.set(pathOf(r), res);
        }
      },
      keys: () => Promise.resolve([...store.keys()]),
    });
  };
  let network: (p: string) => Promise<Response> = () => Promise.reject(new Error('no network'));
  return {
    stores,
    writes,
    setNetwork: (fn: (p: string) => Promise<Response>) => {
      network = fn;
    },
    api: {
      open,
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name: string) => Promise.resolve(stores.delete(name)),
      match: async (req: unknown) => {
        for (const s of stores.values()) {
          const hit = s.get(pathOf(req));
          if (hit) return hit.clone();
        }
        return undefined;
      },
    },
  };
}

function boot(initial: (path: string) => Response | Promise<Response> = () => new Response('ok', { status: 200 })) {
  let handler = initial;
  const c = fakeCaches();
  const fetched: string[] = [];
  const net = async (p: string): Promise<Response> => {
    fetched.push(p);
    if (p === '/offline') return new Response(OFFLINE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    return handler(p);
  };
  const setHandler = (fn: (path: string) => Response | Promise<Response>) => {
    handler = fn;
  };
  c.setNetwork(net);
  const listeners: Record<string, (e: Record<string, unknown>) => void> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: Record<string, unknown>) => void) => {
      listeners[type] = fn;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(() => Promise.resolve()) },
  };
  const fetchImpl = (req: { url: string }) => net(pathOf(req.url));
  new Function('self', 'caches', 'fetch', 'URL', code)(self, c.api, fetchImpl, URL);

  /** Runs a lifecycle event and waits for what the worker passed to waitUntil. */
  const lifecycle = async (type: 'install' | 'activate', extra: Record<string, unknown> = {}) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners[type]?.({ waitUntil: (p: Promise<unknown>) => (pending = p), ...extra });
    await pending;
  };
  /** Fires a fetch event. Returns the response if the worker handled it, or null if it left it to the browser. */
  const request = async (url: string, init: { method?: string; mode?: string } = {}): Promise<Response | null> => {
    let responded: Promise<Response> | null = null;
    listeners.fetch?.({ request: { url: url.startsWith('http') ? url : `${ORIGIN}${url}`, method: init.method ?? 'GET', mode: init.mode ?? 'cors' }, respondWith: (p: Promise<Response>) => (responded = p) });
    return responded ? await responded : null;
  };
  const message = async (data: unknown) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.message?.({ data, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  return { c, self, fetched, lifecycle, request, message, setHandler };
}

const staticOk = () => new Response('body', { status: 200 });

describe('install', () => {
  it('precaches the offline page, the icons and the offline page’s own scripts and styles, and does not skip waiting', async () => {
    const w = boot(staticOk);
    await w.lifecycle('install');
    expect([...(w.c.stores.get('erase-shell-v1')?.keys() ?? [])].sort()).toEqual(['/brand/favicon.svg', '/brand/icon-192.png', '/brand/icon-512.png', '/brand/logo-wordmark-light.svg', '/manifest.webmanifest', '/offline']);
    expect([...(w.c.stores.get('erase-static-v1')?.keys() ?? [])].sort()).toEqual(['/_next/static/chunks/app.js', '/_next/static/css/app.css']);
    expect(w.self.skipWaiting).not.toHaveBeenCalled(); // an update waits for the person to accept the prompt
  });

  it('caches nothing that could hold personal data', async () => {
    const w = boot(staticOk);
    await w.lifecycle('install');
    const everything = [...w.c.stores.values()].flatMap((s) => [...s.keys()]);
    for (const key of everything) expect(key, key).toMatch(/^\/(offline|manifest\.webmanifest|brand\/|_next\/static\/)/);
    expect(everything.some((k) => k.includes('/v1/'))).toBe(false);
  });
});

describe('fetch', () => {
  it('sends a page navigation to the network and never stores the page', async () => {
    const w = boot(() => new Response('<html>signed-in page with a name</html>', { status: 200 }));
    await w.lifecycle('install');
    const writesBefore = w.c.writes.length;
    const res = await w.request('/overview', { mode: 'navigate' });
    expect(await res?.text()).toContain('signed-in page');
    expect(w.fetched).toContain('/overview');
    expect(w.c.writes.length).toBe(writesBefore); // nothing written
  });

  it('shows the offline page when a navigation has no network', async () => {
    const w = boot(staticOk);
    await w.lifecycle('install'); // installed while online
    w.setHandler(() => Promise.reject(new Error('offline'))); // then the network goes away
    const res = await w.request('/requests/review', { mode: 'navigate' });
    expect(await res?.text()).toBe(OFFLINE_HTML);
  });

  it('does not handle the API (another origin), same-origin /v1 calls, or anything that is not a GET', async () => {
    const w = boot(staticOk);
    await w.lifecycle('install');
    const writesBefore = w.c.writes.length;
    expect(await w.request('https://api.example/v1/me')).toBeNull();
    expect(await w.request('https://api.example/v1/companies', { mode: 'cors' })).toBeNull();
    expect(await w.request('/v1/requests')).toBeNull();
    expect(await w.request('/v1/requests/drafts', { method: 'POST' })).toBeNull();
    expect(await w.request('/data.json')).toBeNull();
    expect(w.c.writes.length).toBe(writesBefore);
  });

  it('serves hashed static files cache-first: the network once, then the cache', async () => {
    let hits = 0;
    const w = boot((p) => {
      if (p.startsWith('/_next/static/chunks/page-')) hits++;
      return new Response(p.startsWith('/_next/static/chunks/page-') ? 'js' : 'ok', { status: 200 });
    });
    await w.lifecycle('install');
    hits = 0;
    expect(await (await w.request('/_next/static/chunks/page-123.js'))?.text()).toBe('js');
    expect(await (await w.request('/_next/static/chunks/page-123.js'))?.text()).toBe('js');
    expect(hits).toBe(1);
  });

  it('does not cache a failed static response', async () => {
    const w = boot(() => new Response('nope', { status: 500 }));
    await w.lifecycle('activate');
    const res = await w.request('/_next/static/chunks/missing.js');
    expect(res?.status).toBe(500);
    expect([...(w.c.stores.get('erase-static-v1')?.keys() ?? [])]).toEqual([]);
  });

  it('after a whole session of requests, the caches still hold only static files', async () => {
    const w = boot((p) => new Response(/^\/(overview|connect|v1\/)/.test(p) ? 'private data' : 'static', { status: 200 }));
    await w.lifecycle('install');
    for (const [url, mode] of [['/overview', 'navigate'], ['/connect', 'navigate'], ['/_next/static/a.js', 'no-cors'], ['/brand/logo-mark.svg', 'no-cors'], ['/v1/companies', 'cors'], ['https://api.example/v1/me', 'cors']] as const) {
      await w.request(url, { mode });
    }
    const everything = [...w.c.stores.values()].flatMap((s) => [...s.keys()]);
    for (const key of everything) expect(key, key).toMatch(/^\/(offline|manifest\.webmanifest|brand\/|_next\/static\/)/);
    for (const store of w.c.stores.values()) for (const res of store.values()) expect(await res.clone().text()).not.toBe('private data');
  });
});

describe('activate and messages', () => {
  it('deletes caches from older versions and keeps the current ones', async () => {
    const w = boot(staticOk);
    await w.c.api.open('erase-shell-v0');
    await w.c.api.open('some-other-cache');
    await w.lifecycle('install');
    await w.lifecycle('activate');
    expect([...w.c.stores.keys()].sort()).toEqual(['erase-shell-v1', 'erase-static-v1']);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });

  it('skips waiting only when told to (the person accepted the update)', async () => {
    const w = boot(staticOk);
    await w.message({ type: 'SOMETHING_ELSE' });
    expect(w.self.skipWaiting).not.toHaveBeenCalled();
    await w.message({ type: 'SKIP_WAITING' });
    expect(w.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('deletes every cache on CLEAR_CACHES (sign-out)', async () => {
    const w = boot(staticOk);
    await w.lifecycle('install');
    expect(w.c.stores.size).toBe(2);
    await w.message({ type: 'CLEAR_CACHES' });
    expect(w.c.stores.size).toBe(0);
  });
});

describe('the precache list matches files that exist', () => {
  // public/brand is generated from packages/ui by scripts/sync-brand.mjs (gitignored). If a precached file is missing,
  // the worker's install fails and it never activates, so every file named here must exist at the source.
  const listed = [...code.matchAll(/'(\/brand\/[^']+)'/g)].map((m) => m[1] as string);
  it('names at least the icons and logo', () => {
    expect(listed.length).toBeGreaterThanOrEqual(3);
  });
  it.each(listed)('%s exists in the shared brand assets', (file) => {
    expect(existsSync(path.resolve(__dirname, '../../../packages/ui/assets/brand', path.basename(file)))).toBe(true);
  });
});
