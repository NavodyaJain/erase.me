/* Erase.me service worker (hand-written, no build step).
 *
 * It caches the static app shell only: the offline page, icons, and the hashed static files Next.js serves under
 * /_next/static. It NEVER caches API responses, the HTML of any page, or anything that could hold personal data:
 *  - navigations go to the network; only when the network fails do they get the offline page;
 *  - requests to any other origin (the API) are not handled at all;
 *  - everything else is left to the browser.
 * On sign-out the app sends CLEAR_CACHES and every cache is deleted. A new worker waits until the person accepts the
 * "update available" prompt (SKIP_WAITING). tests/sw.test.ts exercises this file.
 */
const VERSION = 'v1';
const SHELL_CACHE = `erase-shell-${VERSION}`;
const STATIC_CACHE = `erase-static-${VERSION}`;
const KEEP = [SHELL_CACHE, STATIC_CACHE];

const PRECACHE = ['/offline', '/manifest.webmanifest', '/brand/icon-192.png', '/brand/icon-512.png', '/brand/favicon.svg', '/brand/logo-wordmark-light.svg'];
/** Public, content-hashed or fixed brand files. Nothing under these paths depends on who is signed in. */
const STATIC_PREFIXES = ['/_next/static/', '/brand/'];

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

async function precache() {
  const shell = await caches.open(SHELL_CACHE);
  await shell.addAll(PRECACHE);
  // The offline page needs its own scripts and styles to render with no network: find them in its HTML.
  const offline = await shell.match('/offline');
  if (!offline) return;
  const html = await offline.clone().text();
  const assets = [...new Set([...html.matchAll(/(?:href|src)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]))];
  const statics = await caches.open(STATIC_CACHE);
  await Promise.all(assets.map((url) => statics.add(url).catch(() => undefined)));
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !KEEP.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // the API and anything else off this origin: not ours to touch

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline')));
    return;
  }
  if (STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (type === 'CLEAR_CACHES') {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
  }
});
