import { createForegroundRecovery } from "./foreground-recovery.ts";
// Package contract tests.
import { assert, assertCount } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

function event(name: string, values: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(name), values);
}

test("foreground signals single-flight a managed reconnect", async () => {
  const page = new EventTarget();
  const document = new EventTarget();
  let resolveReconnect: (() => void) | undefined;
  let reconnects = 0;
  const manager = createForegroundRecovery({
    enabled: true,
    pageTarget: page,
    visibilityTarget: document,
    isVisible: () => true,
    isOnline: () => true,
    reconnect: () => {
      reconnects += 1;
      return new Promise<void>((resolve) => resolveReconnect = resolve);
    },
  });
  document.dispatchEvent(event("visibilitychange"));
  page.dispatchEvent(event("online"));
  assertCount(reconnects, 1, "overlapping foreground signals stacked reconnect calls");
  resolveReconnect?.();
  await Promise.resolve();
  await Promise.resolve();
  assert(manager.getState().status === "completed", "completed reconnect was not observable");
  assertCount(manager.getState().attempts, 1, "single-flight reconnect counted twice");
  manager.dispose();
});

test("offline foreground recovery defers until the online event", async () => {
  const page = new EventTarget();
  const document = new EventTarget();
  let online = false;
  let reconnects = 0;
  const manager = createForegroundRecovery({
    enabled: true,
    pageTarget: page,
    visibilityTarget: document,
    isVisible: () => true,
    isOnline: () => online,
    reconnect: () => {
      reconnects += 1;
      return Promise.resolve();
    },
  });
  document.dispatchEvent(event("visibilitychange"));
  assert(manager.getState().status === "offline-deferred", "offline state was not retained");
  assertCount(reconnects, 0, "offline foreground signal attempted reconnect");
  online = true;
  page.dispatchEvent(event("online"));
  await Promise.resolve();
  await Promise.resolve();
  assertCount(reconnects, 1, "online recovery did not request reconnect");
  manager.dispose();
});

test("pageshow recovers only a restored BFCache document", async () => {
  const page = new EventTarget();
  const document = new EventTarget();
  let reconnects = 0;
  const manager = createForegroundRecovery({
    enabled: true,
    pageTarget: page,
    visibilityTarget: document,
    isVisible: () => true,
    isOnline: () => true,
    reconnect: () => {
      reconnects += 1;
      return Promise.resolve();
    },
  });
  page.dispatchEvent(event("pageshow", { persisted: false }));
  page.dispatchEvent(event("pageshow", { persisted: true }));
  await Promise.resolve();
  assertCount(reconnects, 1, "pageshow did not distinguish initial load from BFCache recovery");
  manager.dispose();
});

test("local-only lifecycle attaches no reconnect behavior", async () => {
  const page = new EventTarget();
  const document = new EventTarget();
  let reconnects = 0;
  const manager = createForegroundRecovery({
    enabled: false,
    pageTarget: page,
    visibilityTarget: document,
    isVisible: () => true,
    isOnline: () => true,
    reconnect: () => {
      reconnects += 1;
      return Promise.resolve();
    },
  });
  page.dispatchEvent(event("online"));
  document.dispatchEvent(event("visibilitychange"));
  await manager.request("online");
  assertCount(reconnects, 0, "local-only mode invented a transport recovery action");
  assert(manager.getState().mode === "local-only", "local-only lifecycle mode was hidden");
  manager.dispose();
});

test("event recovery records a reconnect rejection without leaving it unhandled", async () => {
  const page = new EventTarget();
  const document = new EventTarget();
  const manager = createForegroundRecovery({
    enabled: true,
    pageTarget: page,
    visibilityTarget: document,
    isVisible: () => true,
    isOnline: () => true,
    reconnect: () => Promise.reject(new Error("sentinel reconnect failure")),
  });
  page.dispatchEvent(event("online"));
  await Promise.resolve();
  await Promise.resolve();
  assert(manager.getState().status === "failed", "reconnect failure was not observable");
  manager.dispose();
});

test("disposed lifecycle removes every browser event listener", async () => {
  const page = new EventTarget();
  const document = new EventTarget();
  let reconnects = 0;
  const manager = createForegroundRecovery({
    enabled: true,
    pageTarget: page,
    visibilityTarget: document,
    isVisible: () => true,
    isOnline: () => true,
    reconnect: () => {
      reconnects += 1;
      return Promise.resolve();
    },
  });
  manager.dispose();
  page.dispatchEvent(event("online"));
  page.dispatchEvent(event("pageshow", { persisted: true }));
  document.dispatchEvent(event("visibilitychange"));
  await Promise.resolve();
  assertCount(reconnects, 0, "disposed lifecycle retained a browser listener");
});

test("recovery is idle while the live gate withholds consent", async () => {
  const page = new EventTarget();
  const document = new EventTarget();
  let elected = false;
  let reconnects = 0;
  const manager = createForegroundRecovery({
    enabled: true,
    pageTarget: page,
    visibilityTarget: document,
    isVisible: () => true,
    isOnline: () => true,
    shouldReconnect: () => elected,
    reconnect: () => {
      reconnects += 1;
      return Promise.resolve();
    },
  });
  // A configured server is not consent: with sync stopped or the transport
  // paused, foreground signals must not silently resume replication.
  document.dispatchEvent(event("visibilitychange"));
  page.dispatchEvent(event("online"));
  await Promise.resolve();
  assertCount(reconnects, 0, "recovery reconnected without an election");
  assert(manager.getState().status === "idle", "a withheld gate must leave recovery idle");
  assertCount(manager.getState().attempts, 0, "a withheld gate must not count attempts");
  elected = true;
  page.dispatchEvent(event("online"));
  await Promise.resolve();
  await Promise.resolve();
  assertCount(reconnects, 1, "an elected account must recover on the next signal");
  manager.dispose();
});
