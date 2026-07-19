const BUILD_REVISION = "__LOFI_BUILD_REVISION__";
// Package-owned service worker source.
// Cache names carry the registration scope so sibling lofi apps on the same
// origin never see or delete each other's caches. The `lofi-scope-` family
// also deliberately escapes the legacy `lofi-shell-`/`lofi-runtime-` prefixes,
// so a sibling still running a pre-scoped worker cannot prune these caches.
const SCOPE_KEY = new URL(self.registration.scope).pathname
  .replace(/[^a-zA-Z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "") || "root";
const SHELL_CACHE_PREFIX = `lofi-scope-${SCOPE_KEY}-shell-`;
const RUNTIME_CACHE_PREFIX = `lofi-scope-${SCOPE_KEY}-runtime-`;
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
      // fails as one transaction rather than claiming readiness with a partial
      // shell. Mutable paths (HTML, manifests) use `cache: "reload"`, matching
      // the manifest's no-store fetch — otherwise a new revision's cache could
      // be populated from stale HTTP-cached responses and serve them
      // cache-first indefinitely. Build assets under `_astro/` carry a content
      // hash in their name, so a stale response is impossible; admitting the
      // HTTP cache for them lets a first visit reuse the bytes the page's own
      // module and engine fetches just downloaded instead of downloading the
      // shell a second time.
      const cache = await caches.open(SHELL_CACHE_NAME);
      await cache.addAll(
        paths.map((path) => {
          const url = new URL(path, self.registration.scope);
          const contentHashed = /(?:^|\/)_astro\//.test(url.pathname);
          return new Request(url, contentHashed ? {} : { cache: "reload" });
        }),
      );
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
    // Prune only this scope's stale revisions. Legacy unscoped
    // `lofi-shell-*`/`lofi-runtime-*` names are left alone: they are
    // indistinguishable from a sibling app's caches, and deleting what we
    // cannot prove is ours is the failure mode this scoping exists to end.
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

// Look up responses only in this worker's own caches. An unscoped
// caches.match() searches every cache on the origin, letting product or
// sibling-app caches shadow lofi resources before ours are even consulted.
async function matchOwnCaches(request, options) {
  const shell = await caches.open(SHELL_CACHE_NAME);
  const cached = await shell.match(request, options);
  if (cached) return cached;
  const runtime = await caches.open(RUNTIME_CACHE_NAME);
  return await runtime.match(request, options);
}

async function cachedPrerenderedNavigation(request) {
  const requestUrl = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (requestUrl.origin !== scope.origin || !requestUrl.pathname.startsWith(scope.pathname)) {
    return undefined;
  }
  const route = requestUrl.pathname.slice(scope.pathname.length).replace(/^\/+|\/+$/g, "");
  if (!route) return await matchOwnCaches(scope);
  return await matchOwnCaches(new URL(`${route}/index.html`, scope));
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
  const cached = await matchOwnCaches(request, {
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
      const shell = await matchOwnCaches(new URL("./", self.registration.scope));
      if (shell) return { response: shell };
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Cached responses are complete 200s; answering a Range request with one
  // breaks seeking and Safari media playback. Let the browser go to network.
  if (event.request.headers?.get?.("range")) return;
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
