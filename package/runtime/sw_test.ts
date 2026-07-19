const serviceWorkerUrl = new URL("./sw.js", import.meta.url);
const revision = "__LOFI_BUILD_REVISION__";
// The harness registers at scope https://example.com/app/, so cache names
// carry the "app" scope key and never collide with sibling base paths.
const shellCacheName = `lofi-scope-app-shell-${revision}`;
const runtimeCacheName = `lofi-scope-app-runtime-${revision}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requestUrl(input: RequestInfo | URL | Record<string, unknown>): string {
  if (input instanceof Request) return input.url;
  if (typeof input === "object" && "url" in input) return String(input.url);
  return String(input);
}

class MemoryCache {
  readonly entries = new Map<string, Response>();
  putGate: Promise<void> | undefined;
  failPut = false;

  match(
    input: RequestInfo | URL,
    options: CacheQueryOptions = {},
  ): Promise<Response | undefined> {
    const requested = new URL(requestUrl(input));
    if (options.ignoreSearch) requested.search = "";
    for (const [key, response] of this.entries) {
      const candidate = new URL(key);
      if (options.ignoreSearch) candidate.search = "";
      if (candidate.href === requested.href) return Promise.resolve(response.clone());
    }
    return Promise.resolve(undefined);
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    if (this.putGate) await this.putGate;
    if (this.failPut) throw new Error("simulated cache write failure");
    this.entries.set(requestUrl(input), response.clone());
  }

  delete(input: RequestInfo | URL): Promise<boolean> {
    return Promise.resolve(this.entries.delete(requestUrl(input)));
  }

  keys(): Promise<Request[]> {
    return Promise.resolve([...this.entries.keys()].map((url) => new Request(url)));
  }

  async addAll(inputs: readonly (RequestInfo | URL)[]): Promise<void> {
    const responses = await Promise.all(inputs.map(async (input) => {
      const response = await fetch(input);
      if (!response.ok) throw new Error(`cache add failed: ${response.status}`);
      return { input, response };
    }));
    for (const { input, response } of responses) await this.put(input, response);
  }
}

class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();

  open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.stores.set(name, cache);
    }
    return Promise.resolve(cache);
  }

  async match(
    input: RequestInfo | URL,
    options?: MultiCacheQueryOptions,
  ): Promise<Response | undefined> {
    if (options?.cacheName) return await (await this.open(options.cacheName)).match(input, options);
    for (const cache of this.stores.values()) {
      const response = await cache.match(input, options);
      if (response) return response;
    }
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name));
  }
}

type ServiceWorkerHandler = (event: Record<string, unknown>) => void;
type FetchResult = {
  response?: Promise<Response>;
  lifetimes: Promise<unknown>[];
  waitUntilCalls: number;
};

async function serviceWorkerHarness(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const handlers = new Map<string, ServiceWorkerHandler>();
  const messages: unknown[] = [];
  const caches = new MemoryCacheStorage();
  let claimed = 0;
  const fakeSelf = {
    location: { origin: "https://example.com" },
    registration: { scope: "https://example.com/app/" },
    clients: {
      claim() {
        claimed += 1;
        return Promise.resolve();
      },
      matchAll() {
        return Promise.resolve([{ postMessage: (message: unknown) => messages.push(message) }]);
      },
    },
    skipWaiting: () => Promise.resolve(),
    addEventListener(type: string, handler: ServiceWorkerHandler) {
      handlers.set(type, handler);
    },
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replacements: Array<[string, unknown]> = [
    ["self", fakeSelf],
    ["caches", caches],
    ["fetch", fetchImpl],
  ];
  for (const [name, value] of replacements) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  await import(`${serviceWorkerUrl.href}?test=${crypto.randomUUID()}`);

  const dispatchLifecycle = async (type: "install" | "activate") => {
    const lifetimes: Promise<unknown>[] = [];
    const handler = handlers.get(type);
    assert(handler, `service worker omitted ${type} handler`);
    handler({ waitUntil: (promise: Promise<unknown>) => lifetimes.push(Promise.resolve(promise)) });
    await Promise.all(lifetimes);
  };
  const dispatchFetch = (request: Record<string, unknown>): FetchResult => {
    const lifetimes: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    let waitUntilCalls = 0;
    const handler = handlers.get("fetch");
    assert(handler, "service worker omitted fetch handler");
    handler({
      request,
      respondWith: (promise: Promise<Response>) => response = Promise.resolve(promise),
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilCalls += 1;
        lifetimes.push(Promise.resolve(promise));
      },
    });
    return { response, lifetimes, waitUntilCalls };
  };
  const close = () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
  return { caches, claimed: () => claimed, close, dispatchFetch, dispatchLifecycle, messages };
}

function fakeRequest(
  url: string,
  options: { destination?: string; mode?: string; method?: string } = {},
): Record<string, unknown> {
  return {
    url,
    destination: options.destination ?? "",
    mode: options.mode ?? "same-origin",
    method: options.method ?? "GET",
  };
}

Deno.test("precache installation is atomic and reports an incomplete required shell", async () => {
  const harness = await serviceWorkerHarness((input) => {
    const url = requestUrl(input);
    if (url.endsWith("lofi-precache.json")) {
      return Promise.resolve(Response.json(["./", "./missing.js"]));
    }
    return Promise.resolve(
      new Response(url.endsWith("missing.js") ? "missing" : "shell", {
        status: url.endsWith("missing.js") ? 404 : 200,
      }),
    );
  });
  try {
    let rejected = false;
    try {
      await harness.dispatchLifecycle("install");
    } catch {
      rejected = true;
    }
    assert(rejected, "partial required shell did not reject installation");
    assert(
      JSON.stringify(harness.messages).includes('"code":"precache"'),
      "precache failure was not reported",
    );
  } finally {
    harness.close();
  }
});

Deno.test("offline nested navigation uses its precached prerendered page", async () => {
  let offline = false;
  const harness = await serviceWorkerHarness((input) => {
    if (offline) return Promise.reject(new Error("offline"));
    const url = requestUrl(input);
    if (url.endsWith("lofi-precache.json")) {
      return Promise.resolve(Response.json(["./", "./settings/index.html"]));
    }
    return Promise.resolve(
      new Response(url.endsWith("settings/index.html") ? "nested settings" : "root shell"),
    );
  });
  try {
    await harness.dispatchLifecycle("install");
    offline = true;
    const event = harness.dispatchFetch(fakeRequest("https://example.com/app/settings/", {
      mode: "navigate",
    }));
    assert(event.response, "navigation was not handled");
    assert(await (await event.response).text() === "nested settings", "nested shell was not used");
    await Promise.all(event.lifetimes);
  } finally {
    harness.close();
  }
});

Deno.test("runtime cache writes remain attached to the fetch event lifetime", async () => {
  const harness = await serviceWorkerHarness(() => Promise.resolve(new Response("image bytes")));
  let releasePut: () => void = () => undefined;
  const putGate = new Promise<void>((resolve) => releasePut = resolve);
  try {
    const runtime = await harness.caches.open(runtimeCacheName);
    runtime.putGate = putGate;
    const request = fakeRequest("https://example.com/app/photo.png", { destination: "image" });
    const event = harness.dispatchFetch(request);
    assert(event.waitUntilCalls === 1, "runtime lifecycle was not attached synchronously");
    assert(event.response, "eligible request was not handled");
    assert(await (await event.response).text() === "image bytes", "network response was delayed");
    let settled = false;
    void Promise.all(event.lifetimes).then(() => settled = true);
    await Promise.resolve();
    assert(!settled, "fetch lifetime settled before the cache write");
    releasePut();
    await Promise.all(event.lifetimes);
    assert(
      await runtime.match("https://example.com/app/photo.png"),
      "runtime response was not cached",
    );
  } finally {
    harness.close();
  }
});

Deno.test("runtime cache rejects disallowed destinations and private responses", async () => {
  const harness = await serviceWorkerHarness((input) => {
    const privateResponse = requestUrl(input).endsWith("private.png");
    return Promise.resolve(
      new Response("network", {
        headers: privateResponse ? { "cache-control": "private" } : undefined,
      }),
    );
  });
  try {
    const documentEvent = harness.dispatchFetch(
      fakeRequest("https://example.com/app/data.json", { destination: "" }),
    );
    assert(documentEvent.response, "same-origin request was not answered");
    await documentEvent.response;
    await Promise.all(documentEvent.lifetimes);

    const privateEvent = harness.dispatchFetch(
      fakeRequest("https://example.com/app/private.png", { destination: "image" }),
    );
    assert(privateEvent.response, "private image request was not answered");
    await privateEvent.response;
    await Promise.all(privateEvent.lifetimes);

    const outsideScope = harness.dispatchFetch(
      fakeRequest("https://example.com/outside/photo.png", { destination: "image" }),
    );
    assert(outsideScope.response, "same-origin outside-scope request was not answered");
    await outsideScope.response;
    await Promise.all(outsideScope.lifetimes);
    const runtime = await harness.caches.open(runtimeCacheName);
    assert((await runtime.keys()).length === 0, "unsuitable responses entered runtime cache");

    const crossOrigin = harness.dispatchFetch(
      fakeRequest("https://cdn.example.net/photo.png", { destination: "image" }),
    );
    assert(!crossOrigin.response, "cross-origin request was intercepted");
  } finally {
    harness.close();
  }
});

Deno.test("runtime cache evicts its oldest entry at the fixed size bound", async () => {
  const harness = await serviceWorkerHarness(() => Promise.resolve(new Response("new")));
  try {
    const runtime = await harness.caches.open(runtimeCacheName);
    for (let index = 0; index < 64; index += 1) {
      await runtime.put(`https://example.com/app/${index}.png`, new Response(String(index)));
    }
    const event = harness.dispatchFetch(
      fakeRequest("https://example.com/app/new.png", { destination: "image" }),
    );
    assert(event.response, "bounded cache request was not answered");
    await event.response;
    await Promise.all(event.lifetimes);
    assert((await runtime.keys()).length === 64, "runtime cache exceeded its size bound");
    assert(!(await runtime.match("https://example.com/app/0.png")), "oldest entry was not evicted");
    assert(await runtime.match("https://example.com/app/new.png"), "newest entry was not retained");
  } finally {
    harness.close();
  }
});

Deno.test("activation prunes only this scope's stale revisions", async () => {
  const harness = await serviceWorkerHarness(() => Promise.resolve(new Response("unused")));
  try {
    await harness.caches.open(`lofi-scope-app-shell-old`);
    await harness.caches.open(`lofi-scope-app-runtime-old`);
    await harness.caches.open(shellCacheName);
    await harness.caches.open(runtimeCacheName);
    // A sibling lofi app at another base path and a legacy unscoped cache —
    // neither provably ours, neither may be deleted.
    await harness.caches.open("lofi-scope-other-shell-old");
    await harness.caches.open("lofi-shell-legacy");
    await harness.caches.open("lofi-runtime-legacy");
    await harness.caches.open("product-cache");
    await harness.dispatchLifecycle("activate");
    const names = await harness.caches.keys();
    assert(!names.includes("lofi-scope-app-shell-old"), "stale shell revision survived activation");
    assert(
      !names.includes("lofi-scope-app-runtime-old"),
      "stale runtime revision survived activation",
    );
    assert(
      names.includes(shellCacheName) && names.includes(runtimeCacheName),
      "current caches removed",
    );
    assert(
      names.includes("lofi-scope-other-shell-old"),
      "a sibling app's scoped cache was deleted",
    );
    assert(
      names.includes("lofi-shell-legacy") && names.includes("lofi-runtime-legacy"),
      "ambiguous legacy caches were deleted",
    );
    assert(names.includes("product-cache"), "unrelated cache was removed");
    assert(harness.claimed() === 1, "activation did not claim clients");
  } finally {
    harness.close();
  }
});

Deno.test("lookups never read another cache on the origin", async () => {
  const harness = await serviceWorkerHarness(() => Promise.resolve(new Response("network")));
  try {
    const product = await harness.caches.open("product-cache");
    await product.put("https://example.com/app/photo.png", new Response("product shadow"));
    const event = harness.dispatchFetch(
      fakeRequest("https://example.com/app/photo.png", { destination: "image" }),
    );
    assert(event.response, "request was not handled");
    assert(
      await (await event.response).text() === "network",
      "a foreign cache shadowed the worker's own caches",
    );
    await Promise.all(event.lifetimes);
  } finally {
    harness.close();
  }
});

Deno.test("shell precache bypasses the HTTP cache only for mutable assets", async () => {
  const precacheInputs: Array<RequestInfo | URL> = [];
  const harness = await serviceWorkerHarness((input) => {
    const url = requestUrl(input);
    if (url.endsWith("lofi-precache.json")) {
      return Promise.resolve(
        Response.json([
          "./",
          "./_astro/runtime.AAAA1111.js",
          "./_astro/jazz_wasm_bg.BBBB2222.wasm",
        ]),
      );
    }
    precacheInputs.push(input);
    return Promise.resolve(new Response("shell"));
  });
  try {
    await harness.dispatchLifecycle("install");
    assert(precacheInputs.length === 3, "expected three precached shell assets");
    const modes = new Map<string, string>();
    for (const input of precacheInputs) {
      assert(input instanceof Request, "precache must construct explicit requests");
      modes.set(new URL(input.url).pathname, input.cache);
    }
    assert(
      modes.get("/app/") === "reload",
      "mutable shell assets must bypass the HTTP cache, matching the manifest's no-store fetch",
    );
    assert(
      modes.get("/app/_astro/runtime.AAAA1111.js") === "default" &&
        modes.get("/app/_astro/jazz_wasm_bg.BBBB2222.wasm") === "default",
      "content-hashed assets must admit the HTTP cache so a first visit is not downloaded twice",
    );
  } finally {
    harness.close();
  }
});

Deno.test("range requests are left to the network", async () => {
  const harness = await serviceWorkerHarness(() => Promise.resolve(new Response("full body")));
  try {
    const shell = await harness.caches.open(shellCacheName);
    await shell.put("https://example.com/app/audio.mp3", new Response("cached full"));
    const event = harness.dispatchFetch({
      ...fakeRequest("https://example.com/app/audio.mp3", { destination: "" }),
      headers: { get: (name: string) => name === "range" ? "bytes=0-1023" : null },
    });
    assert(
      event.response === undefined,
      "a Range request must not be answered with a cached 200",
    );
  } finally {
    harness.close();
  }
});

Deno.test("runtime cache failure is reported without failing the network response", async () => {
  const harness = await serviceWorkerHarness(() => Promise.resolve(new Response("network image")));
  try {
    const runtime = await harness.caches.open(runtimeCacheName);
    runtime.failPut = true;
    const event = harness.dispatchFetch(
      fakeRequest("https://example.com/app/photo.png", { destination: "image" }),
    );
    assert(event.response, "runtime failure request was not answered");
    assert(await (await event.response).text() === "network image", "cache failure lost response");
    await Promise.all(event.lifetimes);
    assert(
      JSON.stringify(harness.messages).includes('"code":"runtime-cache"'),
      "runtime cache failure was not reported",
    );
  } finally {
    harness.close();
  }
});
