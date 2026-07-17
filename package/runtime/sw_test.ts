const serviceWorkerUrl = new URL("./sw.js", import.meta.url);

Deno.test("service worker precaches the shell and reports install failures", async () => {
  const source = await Deno.readTextFile(serviceWorkerUrl);
  for (
    const contract of [
      'new URL("./lofi-precache.json", self.registration.scope)',
      "cache.addAll",
      'reportFailure(\n        "precache"',
      'name.startsWith("lofi-shell-")',
    ]
  ) {
    if (!source.includes(contract)) throw new Error(`service worker omitted ${contract}`);
  }
});

Deno.test("service worker uses cached navigation shell as the offline fallback", async () => {
  const source = await Deno.readTextFile(serviceWorkerUrl);
  for (
    const contract of [
      'event.request.mode === "navigate"',
      "cachedPrerenderedNavigation(event.request)",
      "new URL(`${route}/index.html`, scope)",
      'caches.match(new URL("./", self.registration.scope))',
      'reportFailure(\n            "runtime-cache"',
    ]
  ) {
    if (!source.includes(contract)) throw new Error(`service worker omitted ${contract}`);
  }
});
