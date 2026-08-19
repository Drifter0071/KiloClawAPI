// NCT Szerviz Ai v2 — service worker (PWA / offline shell, feature #4).
//
// Scoped to /dashboard/v2/ (registered from the operator SPA).
//
// Cache strategy:
//   - PRECACHE at install: the shell (index.html), manifest, icons —
//     so the app can boot offline with the "stale shell" the moment
//     the network dies.
//   - Navigations (any /dashboard/v2/... URL): network-first, falling
//     back to the cached shell (offline boot).
//   - /dashboard/v2/assets/*: cache-first (hashed chunks are
//     immutable), fetch + put on miss.
//   - /dashboard/api/*: NEVER intercepted — these are cookie-gated
//     (HttpOnly auth cookie) and must always hit the network. Caching
//     them would serve 401/403 pages from a stale cache.
//   - Everything else under scope: network-first with cache fallback.
//
// Bump VERSION when the shell's behavior changes to invalidate old
// caches on activate.

const VERSION = 'nct-v2-v1'
const SHELL_CACHE = `${VERSION}-shell`
const ASSET_CACHE = `${VERSION}-assets`

const PRECACHE_URLS = [
  './',
  './ask',
  './manifest.webmanifest',
  './favicon.png',
  './apple-touch-icon.png',
  './android-chrome-192.png',
  './android-chrome-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('nct-v2-') && k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  // Cookie-gated API — always network. NEVER cache.
  if (url.pathname.startsWith('/dashboard/api/')) return

  // Navigations: network-first, stale shell offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone()
          caches
            .open(SHELL_CACHE)
            .then((c) => c.put('./', copy))
            .catch(() => {})
          return res
        })
        .catch(() =>
          caches.match('./').then((hit) => hit || caches.match('./ask')),
        ),
    )
    return
  }

  // Hashed static chunks: cache-first.
  if (url.pathname.startsWith('/dashboard/v2/assets/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone()
            caches
              .open(ASSET_CACHE)
              .then((c) => c.put(event.request, copy))
              .catch(() => {})
            return res
          }),
      ),
    )
    return
  }

  // Anything else under scope: network-first, cache fallback.
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)))
})
