// Service worker for cmms-api ask dashboard.
// Strategy: stale-while-revalidate for static assets, network-first for /v1/*.
const CACHE = "cmms-ask-v1";
const STATIC = [
  "/dashboard/ask/",
  "/dashboard/ask/manifest.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API: always network, never cache.
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/dashboard/api/")) {
    return;
  }
  // Static: stale-while-revalidate.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
