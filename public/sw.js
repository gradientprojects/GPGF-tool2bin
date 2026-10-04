// Offline cache: same-origin GETs are cached on first fetch (the app's
// assets are content-hashed, so stale entries never collide). The big
// WASM blobs land here too -> the app works offline after one load.
const CACHE = "tool2bin-v1";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request);
    if (hit) return hit;
    const resp = await fetch(e.request);
    if (resp.ok) cache.put(e.request, resp.clone());
    return resp;
  })());
});
