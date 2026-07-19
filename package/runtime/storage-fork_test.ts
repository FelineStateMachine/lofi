import {
  createStorageForkGuard,
  describeStorageFork,
  type StorageForkDiagnostics,
  type StorageForkGuardDependencies,
  type StorageForkState,
} from "./storage-fork.ts";
import { assert } from "./test-assert.ts";

class FakeStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

class FakeCookieJar {
  readonly values = new Map<string, string>();
  lastWritten: string | null = null;

  read(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  write(cookie: string): void {
    this.lastWritten = cookie;
    const [pair, ...attributes] = cookie.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const maxAge = attributes.find((attribute) => attribute.toLowerCase().startsWith("max-age="));
    if (maxAge && Number(maxAge.slice("max-age=".length)) <= 0) this.values.delete(name);
    else this.values.set(name, pair.slice(separator + 1));
  }
}

class FakeDiagnostics {
  #state: StorageForkDiagnostics = {
    storageState: "persistent-requested",
    localWaitCalls: 0,
    journaledPendingWrites: 0,
    lastWriteDurability: "none",
  };
  readonly #subscribers = new Set<() => void>();

  get = (): StorageForkDiagnostics => this.#state;
  subscribe = (listener: () => void): () => void => {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  };
  mutate(update: Partial<StorageForkDiagnostics>): void {
    this.#state = { ...this.#state, ...update };
    for (const subscriber of this.#subscribers) subscriber();
  }
}

const appId = "test-app";
const markerKey = `lofi:local-data:${appId}`;
const cookieName = `lofi-fork-${appId}`;

function guardUnderTest(options: {
  production?: boolean;
  storage?: FakeStorage;
  cookies?: FakeCookieJar;
  standalone?: boolean;
  syncing?: boolean;
  diagnostics?: FakeDiagnostics;
  probeLocalRows?: () => Promise<boolean>;
  storageEvents?: EventTarget;
  overrides?: Partial<StorageForkGuardDependencies>;
} = {}) {
  const storage = options.storage ?? new FakeStorage();
  const cookies = options.cookies ?? new FakeCookieJar();
  const diagnostics = options.diagnostics ?? new FakeDiagnostics();
  const guard = createStorageForkGuard({
    production: () => options.production ?? true,
    appId: () => appId,
    storage: () => storage,
    storageKeys: () => storage.keys(),
    readCookies: () => cookies.read(),
    writeCookie: (cookie) => cookies.write(cookie),
    cookiePath: () => "/",
    secureContext: () => true,
    environment: () => ({
      displayModeStandalone: options.standalone ?? false,
      navigatorStandalone: false,
    }),
    syncing: () => options.syncing ?? false,
    diagnostics: () => diagnostics,
    probeLocalRows: options.probeLocalRows ?? (() => Promise.resolve(false)),
    storageEvents: () => options.storageEvents,
    ...options.overrides,
  });
  return { guard, storage, cookies, diagnostics };
}

function waitForState(
  guard: ReturnType<typeof createStorageForkGuard>,
  predicate: (state: StorageForkState) => boolean,
): Promise<StorageForkState> {
  return new Promise((resolve) => {
    const unsubscribe = guard.subscribe((state) => {
      if (!predicate(state)) return;
      unsubscribe();
      resolve(state);
    });
  });
}

function storageEvent(key: string): Event {
  return Object.assign(new Event("storage"), { key });
}

Deno.test("development leaves the guard unarmed and writes no cookie", () => {
  const { guard, cookies } = guardUnderTest({ production: false });
  guard.start();
  const state = guard.getState();
  assert(
    state.state === "unarmed" && state.reason === "development",
    "a development boot did not stay unarmed",
  );
  assert(cookies.lastWritten === null, "a development boot touched cookies");
});

Deno.test("no local data settles idle and deletes a stale flag cookie", () => {
  const cookies = new FakeCookieJar();
  cookies.values.set(cookieName, "1");
  const { guard } = guardUnderTest({ cookies });
  guard.start();
  assert(guard.getState().state === "idle", "an empty browser context was not idle");
  assert(!cookies.values.has(cookieName), "the stale flag cookie was not deleted");
});

Deno.test("a persisted marker without sync is at risk and refreshes the cookie", () => {
  const storage = new FakeStorage();
  storage.setItem(markerKey, "1");
  const { guard, cookies } = guardUnderTest({ storage });
  guard.start();
  assert(guard.getState().state === "browser-data-at-risk", "marked local data was not at risk");
  assert(cookies.values.get(cookieName) === "1", "the flag cookie was not written");
  const written = cookies.lastWritten ?? "";
  for (const attribute of ["Path=/", "SameSite=Lax", "Secure", "Max-Age=31536000"]) {
    assert(written.includes(attribute), `the flag cookie lost its ${attribute} attribute`);
  }
});

Deno.test("observed write activity persists the marker and flips to at risk", () => {
  const { guard, storage, cookies, diagnostics } = guardUnderTest();
  guard.start();
  assert(guard.getState().state === "idle", "a fresh context did not start idle");
  diagnostics.mutate({ localWaitCalls: 1 });
  assert(guard.getState().state === "browser-data-at-risk", "write activity did not raise risk");
  assert(storage.getItem(markerKey) === "1", "write activity did not persist the marker");
  assert(cookies.values.get(cookieName) === "1", "write activity did not set the flag cookie");
});

Deno.test("electing sync settles idle and deletes the flag cookie", () => {
  const storage = new FakeStorage();
  storage.setItem(markerKey, "1");
  let syncing = false;
  const { guard, cookies, diagnostics } = guardUnderTest({
    storage,
    overrides: { syncing: () => syncing },
  });
  guard.start();
  assert(guard.getState().state === "browser-data-at-risk", "unsynced data was not at risk");
  syncing = true;
  // Election recreates the runtime, which notifies the diagnostics feed.
  diagnostics.mutate({});
  assert(guard.getState().state === "idle", "electing sync did not settle idle");
  assert(!cookies.values.has(cookieName), "electing sync did not delete the flag cookie");
});

Deno.test("a cross-tab storage event for this app re-evaluates the verdict", () => {
  const storage = new FakeStorage();
  storage.setItem(markerKey, "1");
  const storageEvents = new EventTarget();
  let syncing = false;
  const { guard } = guardUnderTest({
    storage,
    storageEvents,
    overrides: { syncing: () => syncing },
  });
  guard.start();
  assert(guard.getState().state === "browser-data-at-risk", "unsynced data was not at risk");
  syncing = true;
  storageEvents.dispatchEvent(storageEvent(`lofi:sync-elected:${appId}`));
  assert(guard.getState().state === "idle", "a cross-tab election was not observed");
});

Deno.test("a standalone launch into a fresh container with the flag detects the fork", () => {
  const cookies = new FakeCookieJar();
  cookies.values.set(cookieName, "1");
  const { guard } = guardUnderTest({ cookies, standalone: true });
  guard.start();
  const state = guard.getState();
  assert(state.state === "fork-detected", "the inherited flag cookie was not detected");
  assert(
    state.state === "fork-detected" && state.message.includes("still in Safari"),
    "the fork notice does not say where the data lives",
  );
  assert(cookies.values.has(cookieName), "detection cleared the cookie before dismissal");
});

Deno.test("a standalone launch without the flag evaluates normally", () => {
  const { guard } = guardUnderTest({ standalone: true });
  guard.start();
  assert(guard.getState().state === "idle", "a fresh standalone launch was not idle");
});

Deno.test("a used standalone container ignores a stale flag cookie", () => {
  const storage = new FakeStorage();
  storage.setItem(`lofi:schema-version:${appId}`, "{}");
  const cookies = new FakeCookieJar();
  cookies.values.set(cookieName, "1");
  const { guard } = guardUnderTest({ storage, cookies, standalone: true });
  guard.start();
  assert(guard.getState().state !== "fork-detected", "a used container reported a fork");
});

Deno.test("a flag cookie for a different app never detects a fork", () => {
  const cookies = new FakeCookieJar();
  cookies.values.set("lofi-fork-other-app", "1");
  const { guard } = guardUnderTest({ cookies, standalone: true });
  guard.start();
  assert(guard.getState().state === "idle", "another app's cookie leaked across");
});

Deno.test("dismissing a detected fork settles idle and deletes the cookie", () => {
  const cookies = new FakeCookieJar();
  cookies.values.set(cookieName, "1");
  const { guard } = guardUnderTest({ cookies, standalone: true });
  guard.start();
  assert(guard.getState().state === "fork-detected", "the fork was not detected");
  guard.dismissFork();
  assert(guard.getState().state === "idle", "dismissal did not settle idle");
  assert(!cookies.values.has(cookieName), "dismissal did not delete the flag cookie");
  guard.dismissFork();
  assert(guard.getState().state === "idle", "a repeated dismissal changed the verdict");
});

Deno.test("start is idempotent", () => {
  const { guard, cookies } = guardUnderTest();
  guard.start();
  const first = cookies.lastWritten;
  guard.start();
  assert(guard.getState().state === "idle", "a second start changed the verdict");
  assert(cookies.lastWritten === first, "a second start rewrote cookies");
});

Deno.test("throwing browser surfaces settle idle instead of crashing", () => {
  const guard = createStorageForkGuard({
    production: () => true,
    appId: () => appId,
    storage: () => {
      throw new Error("blocked");
    },
    storageKeys: () => {
      throw new Error("blocked");
    },
    readCookies: () => {
      throw new Error("blocked");
    },
    writeCookie: () => {
      throw new Error("blocked");
    },
    environment: () => ({ displayModeStandalone: false, navigatorStandalone: false }),
    syncing: () => false,
    diagnostics: () => new FakeDiagnostics(),
    probeLocalRows: () => Promise.resolve(false),
    storageEvents: () => undefined,
  });
  guard.start();
  assert(guard.getState().state === "idle", "blocked storage did not settle idle");
});

Deno.test("the row probe runs once the persistent driver opens and marks found data", async () => {
  const probes: true[] = [];
  const probeCount = () => probes.length;
  const { guard, storage, diagnostics } = guardUnderTest({
    probeLocalRows: () => {
      probes.push(true);
      return Promise.resolve(true);
    },
  });
  const atRisk = waitForState(guard, (state) => state.state === "browser-data-at-risk");
  guard.start();
  assert(probeCount() === 0, "the probe ran before the persistent driver opened");
  diagnostics.mutate({ storageState: "persistent-driver-open" });
  assert(probeCount() === 1, "the open driver did not trigger the probe");
  await atRisk;
  assert(storage.getItem(markerKey) === "1", "found rows did not persist the marker");
  diagnostics.mutate({});
  assert(probeCount() === 1, "the probe ran more than once");
});

Deno.test("describeStorageFork labels every state for diagnostic surfaces", () => {
  const labels = [
    describeStorageFork({ state: "unarmed", reason: "development" }),
    describeStorageFork({ state: "unarmed", reason: "inactive" }),
    describeStorageFork({ state: "idle" }),
    describeStorageFork({ state: "browser-data-at-risk" }),
    describeStorageFork({ state: "fork-detected", message: "" }),
  ];
  assert(new Set(labels).size === labels.length, "fork states share a label");
  for (const label of labels) assert(label.length > 0, "a fork state lacks a label");
});
