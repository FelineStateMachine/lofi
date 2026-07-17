const BUILD_REVISION = "__LOFI_BUILD_REVISION__";
// Package-owned service worker source.
const SHELL_CACHE_PREFIX = "lofi-shell-";
const RUNTIME_CACHE_PREFIX = "lofi-runtime-";
const SHELL_CACHE_NAME = `${SHELL_CACHE_PREFIX}${BUILD_REVISION}`;
const RUNTIME_CACHE_NAME = `${RUNTIME_CACHE_PREFIX}${BUILD_REVISION}`;
const MAX_RUNTIME_ENTRIES = 64;
const RUNTIME_DESTINATIONS = new Set(["font", "image", "script", "style", "worker"]);

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
      // Every emitted path is part of the generated offline shell. Installation
      // fails as one transaction rather than claiming readiness with a partial shell.
      const cache = await caches.open(SHELL_CACHE_NAME);
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
      const staleShell = name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE_NAME;
      const staleRuntime = name.startsWith(RUNTIME_CACHE_PREFIX) && name !== RUNTIME_CACHE_NAME;
      if (staleShell || staleRuntime) await caches.delete(name);
    }
    // Navigation preload is intentionally disabled: generated routes and their
    // assets are precached, so starting a network request before the cache lookup
    // would spend bandwidth on the normal cache-first path.
    await self.clients.claim();
  })());
});

function cachedPrerenderedNavigation(request) {
  const requestUrl = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (requestUrl.origin !== scope.origin || !requestUrl.pathname.startsWith(scope.pathname)) {
    return undefined;
  }
  const route = requestUrl.pathname.slice(scope.pathname.length).replace(/^\/+|\/+$/g, "");
  if (!route) return caches.match(scope);
  return caches.match(new URL(`${route}/index.html`, scope));
}

function isRuntimeCacheEligible(request) {
  if (request.method !== "GET" || request.mode === "navigate") return false;
  if (!RUNTIME_DESTINATIONS.has(request.destination)) return false;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
}

function isRuntimeResponseCacheable(response) {
  if (!response.ok || response.status === 206) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*(?:no-store|private)(?:\s|,|$)/i.test(cacheControl)) return false;
  return response.headers.get("vary")?.trim() !== "*";
}

async function trimRuntimeCache(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - MAX_RUNTIME_ENTRIES;
  for (const request of keys.slice(0, Math.max(0, overflow))) await cache.delete(request);
}

async function writeRuntimeCache(request, response) {
  const cache = await caches.open(RUNTIME_CACHE_NAME);
  // Reinsert a refreshed URL so cache key order tracks the latest successful write.
  await cache.delete(request);
  await cache.put(request, response);
  await trimRuntimeCache(cache);
}

async function routeRequest(request) {
  const cached = await caches.match(request, {
    ignoreSearch: request.mode === "navigate",
  });
  if (cached) return { response: cached };
  if (request.mode === "navigate") {
    const prerendered = await cachedPrerenderedNavigation(request);
    if (prerendered) return { response: prerendered };
  }
  try {
    const response = await fetch(request);
    const runtimeWrite = isRuntimeCacheEligible(request) && isRuntimeResponseCacheable(response)
      ? writeRuntimeCache(request, response.clone())
      : undefined;
    return { response, runtimeWrite };
  } catch (error) {
    if (request.mode === "navigate") {
      const shell = await caches.match(new URL("./", self.registration.scope));
      if (shell) return { response: shell };
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  const result = routeRequest(event.request);
  event.respondWith(result.then(({ response }) => response));
  // waitUntil is attached synchronously. It follows the eventual cache write
  // without delaying the response or misclassifying ordinary network failures.
  event.waitUntil(result.then(
    ({ runtimeWrite }) =>
      runtimeWrite?.catch((error) =>
        reportFailure(
          "runtime-cache",
          error instanceof Error ? error.message : "runtime cache write failed",
        )
      ),
    () => undefined,
  ));
});
