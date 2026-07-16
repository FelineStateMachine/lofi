import { createForegroundRecovery } from "./foreground-recovery.ts";
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
