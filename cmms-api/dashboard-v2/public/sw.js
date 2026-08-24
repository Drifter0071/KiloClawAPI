// NCT Szerviz Ai v2 — service worker (PWA / offline shell, feature #4,
// + push notifications, Phase 8 / F2, 2026-08-24).
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
// Push notifications:
//   - push: shows a notification with the payload's title/body/url.
//     The default `tag` collapses repeated notifications for the same
//     job_id so the user doesn't get a stack.
//   - notificationclick: focuses an existing dashboard tab if one is
//     open, otherwise opens a new tab at payload.url. Sends a
//     `postMessage({ type: 'nct-push-click', ... })` to every client
//     so in-tab UI (e.g. AskPage) can highlight the new answer.
//
// Bump VERSION when the shell's behavior changes to invalidate old
// caches on activate.

const VERSION = 'nct-v2-v2'
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

// ---------------------------------------------------------------------------
// Push notifications (Phase 8, 2026-08-24, F2).
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload
  try {
    payload = event.data.json()
  } catch {
    payload = { title: 'NCT CMMS', body: event.data.text() }
  }
  const title = String(payload.title ?? 'NCT CMMS')
  const opts = {
    body: String(payload.body ?? ''),
    icon: String(payload.icon ?? '/dashboard/v2/android-chrome-192.png'),
    badge: String(payload.badge ?? '/dashboard/v2/android-chrome-192.png'),
    tag: String(payload.tag ?? 'nct-push'),
    data: {
      url: String(payload.url ?? '/dashboard/v2/ask'),
      job_id: payload.data?.job_id ?? null,
      status: payload.data?.status ?? null,
      final_text: payload.data?.final_text ?? null,
    },
    requireInteraction: false,
    silent: false,
  }
  event.waitUntil(self.registration.showNotification(title, opts))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = String(event.notification.data?.url ?? '/dashboard/v2/ask')
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((wins) => {
        // Prefer a window already on the dashboard; if found, focus it
        // and post the click payload so in-tab UI can react.
        const existing = wins.find((w) => w.url.includes('/dashboard/v2/'))
        if (existing) {
          existing.postMessage({
            type: 'nct-push-click',
            url: target,
            job_id: event.notification.data?.job_id ?? null,
            status: event.notification.data?.status ?? null,
          })
          return existing.focus()
        }
        return self.clients.openWindow(target)
      }),
  )
})

