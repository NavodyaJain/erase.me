import { API, copy, draftFor, expect, test, toOverview } from './helpers';

test('the manifest and its icons load, and the page links to the manifest', async ({ page, request }) => {
  await page.goto('/offline');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('manifest+json');
  const manifest = (await res.json()) as { name: string; display: string; icons: Array<{ src: string; sizes: string; purpose: string; type: string }> };
  expect(manifest).toMatchObject({ name: 'Erase.me', display: 'standalone' });
  expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
  for (const icon of manifest.icons) {
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()['content-type'], icon.src).toContain('image/png');
  }
});

test('the service worker registers, and the offline page shows when the network is gone', async ({ page, context }) => {
  await page.goto('/offline');
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.active) throw new Error('no active worker');
  });
  await page.reload(); // now the page itself is under the worker's control
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  await context.setOffline(true);
  await page.goto('/overview').catch(() => undefined);
  await expect(page.getByRole('heading', { name: copy.offline.title })).toBeVisible();
  await expect(page.getByText(copy.offline.body)).toBeVisible();
  const text = (await page.textContent('body')) ?? '';
  expect(text).not.toMatch(/E2E|@example\.com/); // no personal data on the offline page
  await context.setOffline(false);
});

test('when the API cannot be reached, the app says so and shows no stale data', async ({ page }) => {
  await toOverview(page);
  await expect(page.getByText('E2E Bank', { exact: true })).toBeVisible();
  await page.route(`${API}/**`, (route) => route.abort());
  await page.reload();
  await expect(page.getByText(/Could not reach Erase\.me/)).toBeVisible();
  expect(await page.content()).not.toContain('E2E Bank');
});

test('API responses and personal data are never cached by the service worker', async ({ page, context }) => {
  await page.goto('/offline');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await toOverview(page);
  await draftFor(page, 'E2E Bank');
  await page.goto('/requests');
  await expect(page.getByRole('link', { name: 'E2E Bank' })).toBeVisible();
  const me = (await (await page.request.get(`${API}/v1/me`)).json()) as { csrfToken: string; id: string };

  // Everything the worker stored is a static file, and none of it holds the person's data.
  const stored = await page.evaluate(async () => {
    const out: Array<{ cache: string; url: string; text: string }> = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        const type = res?.headers.get('content-type') ?? '';
        out.push({ cache: name, url: new URL(req.url).pathname + new URL(req.url).search, text: /text|json|javascript/.test(type) ? ((await res?.text()) ?? '') : '' });
      }
    }
    return out;
  });
  expect(stored.length).toBeGreaterThan(0);
  for (const e of stored) {
    expect(e.url, e.url).toMatch(/^\/(offline|manifest\.webmanifest|brand\/|_next\/static\/)/);
    expect(e.text, e.url).not.toMatch(/E2E Bank|e2e\.user|E2E User/);
    expect(e.text, e.url).not.toContain(me.csrfToken);
    expect(e.text, e.url).not.toContain(me.id);
  }

  // With the network off, an API call fails instead of being answered from a cache.
  await context.setOffline(true);
  const result = await page.evaluate(() => fetch('http://localhost:4100/v1/companies', { credentials: 'include' }).then((r) => `status ${r.status}`, () => 'failed'));
  expect(result).toBe('failed');
  await context.setOffline(false);
});
