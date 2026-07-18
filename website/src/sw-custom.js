/**
 * PWA service-worker extension (wired via plugin-pwa's `swCustom`).
 *
 * The site builds with `trailingSlash: false`, so a route like
 * `/docs/getting-started` is emitted as `docs/getting-started.html` — a shape
 * the default worker never checks (it tries only `<path>` and
 * `<path>/index.html`), which would make every deep route miss the precache
 * offline. This handler covers exactly the extensionless, non-slash
 * navigations the default handler cannot match, so the two never race on the
 * same request.
 */
export default function swCustom(params) {
  if (!params.offlineMode) return;
  self.addEventListener("fetch", (event) => {
    if (event.request.mode !== "navigate") return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    const path = url.pathname;
    const lastSegment = path.slice(path.lastIndexOf("/") + 1);
    // "/" and trailing-slash paths belong to the default handler; paths with
    // an extension are assets, not routes.
    if (path === "/" || path.endsWith("/") || lastSegment.includes(".")) return;
    event.respondWith((async () => {
      const cached = await caches.match(`${url.origin}${path}.html`, {
        // Precache keys carry a __WB_REVISION__ query.
        ignoreSearch: true,
      });
      if (cached) return cached;
      return fetch(event.request);
    })());
  });
}
