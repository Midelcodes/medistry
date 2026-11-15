/* Service worker for the offline card scanner. Registered with scope '/s'.
 * Static files: cache-first. Public keys (JWKS): network-first, falling back to the cache.
 * Bump CACHE_VERSION whenever any file in PRECACHE changes, so clients pick up the new copies.
 * Only the URLs below are handled; every other request goes to the network untouched.
 */
const CACHE_VERSION = 'medistry-scan-v3';
const CACHE_PREFIX = 'medistry-scan-';
const JWKS_URL = '/.well-known/medistry-keys.json';
const PRECACHE = [
  '/s',
  '/js/scan.js',
  '/js/lib/verifyCard.js',
  '/js/common.js',
  '/css/styles.css',
  '/css/pages.css',
  '/css/scan.css',
  '/vendor/jsQR.js',
  '/assets/favicon.svg',
  JWKS_URL,
];

// One file at a time, so a failed install names the file that could not be fetched.
async function precache() {
  const cache = await caches.open(CACHE_VERSION);
  for (const url of PRECACHE) {
    const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
    if (!res.ok) throw new Error(`Precache failed for ${url}: ${res.status}`);
    await cache.put(url, res);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === JWKS_URL) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(JWKS_URL, copy));
        }
        return res;
      }).catch(() => caches.match(JWKS_URL).then((hit) => hit || Response.error()))
    );
    return;
  }

  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.match(url.pathname, { ignoreSearch: true }).then((hit) => hit || fetch(req))
    );
  }
});
