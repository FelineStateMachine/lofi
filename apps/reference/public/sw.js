const BUILD_REVISION = "__LOFI_BUILD_REVISION__";
const CACHE_NAME = `lofi-shell-${BUILD_REVISION}`;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const manifestUrl = new URL("./lofi-precache.json", self.registration.scope);
    const response = await fetch(manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`precache manifest failed: ${response.status}`);
    const paths = await response.json();
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(paths.map((path) => new URL(path, self.registration.scope)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("lofi-shell-") && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(event.request, {
      ignoreSearch: event.request.mode === "navigate",
    });
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        void cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      if (event.request.mode === "navigate") {
        const shell = await caches.match(new URL("./", self.registration.scope));
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
