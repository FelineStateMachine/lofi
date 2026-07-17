const BUILD_REVISION = "__LOFI_BUILD_REVISION__";
// Package-owned service worker source.
const CACHE_NAME = `lofi-shell-${BUILD_REVISION}`;

async function reportFailure(code, message) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    client.postMessage({ type: "LOFI_PWA_FAILURE", code, message });
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try {
      const manifestUrl = new URL("./lofi-precache.json", self.registration.scope);
      const response = await fetch(manifestUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`precache manifest failed: ${response.status}`);
      const paths = await response.json();
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(paths.map((path) => new URL(path, self.registration.scope)));
    } catch (error) {
      await reportFailure(
        "precache",
        error instanceof Error ? error.message : "precache failed",
      );
      throw error;
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "LOFI_SKIP_WAITING") event.waitUntil(self.skipWaiting());
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
        void cache.put(event.request, response.clone()).catch((error) =>
          reportFailure(
            "runtime-cache",
            error instanceof Error ? error.message : "runtime cache write failed",
          )
        );
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
