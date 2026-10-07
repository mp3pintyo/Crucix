/* Explicit shell-only policy: no API, event stream, live navigation response or
 * authentication response is written to CacheStorage. Snapshot opt-in uses IDB. */
const CACHE = 'crucix-shell-v2.13.0';
const BASE = ['/offline-shell', '/manifest.webmanifest', '/intelligence.js', '/intelligence.css', '/clock.js', '/replay-core.js', '/replay.js', '/replay.css', '/domains.js', '/lens-core.js', '/lens.js', '/lens.css', '/health-matrix.js', '/health-matrix.css', '/changes.js', '/changes.css', '/risk.js', '/risk.css', '/country.js', '/country.css', '/briefing.js', '/briefing.css', '/palette-core.js', '/palette.js', '/palette.css', '/record-core.js', '/live-sources.js', '/pivots.js', '/record-inspector.js', '/live-sources.css', '/record-inspector.css', '/alerts-core.js', '/alerts.js', '/alert-rules.js', '/alerts.css', '/pwa.js', '/icons/icon-192.png', '/icons/icon-512.png', '/vendor/manifest.json'];
const isVendor = path => /^\/vendor\/[a-zA-Z0-9./_-]+$/.test(path) && !path.includes('..');
async function assetList(cache) {
  const manifest = await cache.match('/vendor/manifest.json');
  if (!manifest) return BASE;
  const ledger = await manifest.json();
  return [...BASE, ...(Array.isArray(ledger.assets) ? ledger.assets.map(a => a.path).filter(isVendor) : [])];
}
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const manifest = await fetch('/vendor/manifest.json', { cache: 'reload' });
  if (!manifest.ok) throw new Error('Asset manifest unavailable');
  await cache.put('/vendor/manifest.json', manifest);
  for (const path of await assetList(cache)) {
    if (path === '/vendor/manifest.json') continue;
    const response = await fetch(path, { cache: 'reload' });
    if (!response.ok || response.status !== 200) throw new Error('Shell asset unavailable');
    await cache.put(path, response);
  }
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('crucix-shell-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('message', event => { if (event.data?.type === 'APPLY_UPDATE') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && url.pathname === '/') {
    // 401/403 must be shown online; do not bypass authentication with the shell.
    event.respondWith(fetch(request).then(async response => response.status >= 500
      ? (await caches.open(CACHE)).match('/offline-shell').then(shell => shell || response) : response)
      .catch(async () => (await caches.open(CACHE)).match('/offline-shell')));
    return;
  }
  if (!BASE.includes(url.pathname) && !isVendor(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (!(await assetList(cache)).includes(url.pathname)) return fetch(request);
    // Online HTML must use the server's matching application code, even while
    // an updated worker waits for the user's explicit activation. Pinned vendor
    // files keep cache-first behavior; fetched application responses aren't saved.
    if(BASE.includes(url.pathname)||url.pathname==='/vendor/fonts.css') {
      return fetch(request).then(async response=>response.status>=500?(await cache.match(url.pathname))||response:response)
        .catch(()=>cache.match(url.pathname));
    }
    return (await cache.match(url.pathname)) || fetch(request);
  })());
});
