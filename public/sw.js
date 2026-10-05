// Offline cache. Navigations (the HTML page) are NETWORK-FIRST with a
// cache fallback, so deployed updates actually reach returning
// visitors; everything else is cache-first (assets are content-hashed,
// so stale entries never collide). The big WASM blobs land here too ->
// the app works offline after one load.
const CACHE = "tool2bin-v2";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) {
    if (k !== CACHE) await caches.delete(k);
  }
  await self.clients.claim();
})()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (e.request.mode === "navigate") {
      try {
        const resp = await fetch(e.request);
        if (resp.ok) cache.put(e.request, resp.clone());
        return resp;
      } catch {
        return (await cache.match(e.request)) ||
               (await cache.match("./")) || Response.error();
      }
    }
    const hit = await cache.match(e.request);
    if (hit) return hit;
    const resp = await fetch(e.request);
    if (resp.ok) cache.put(e.request, resp.clone());
    return resp;
  })());
});
