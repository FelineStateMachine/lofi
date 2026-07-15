import type { Db, MutationErrorEvent } from "jazz-tools";
import { NotesStore, type RuntimeDiagnostics } from "./notes-store.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertCount(actual: number, expected: number, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

function diagnostics(): RuntimeDiagnostics {
  return {
    storageState: "persistent-driver-open",
    clientsCreated: 1,
    activeClients: 1,
    activeConsumers: 0,
    activeVendorSubscriptions: 0,
    totalVendorSubscriptions: 0,
    activeMutationListeners: 1,
    totalMutationListeners: 1,
    unsubscribeCalls: 0,
    localWaitCalls: 0,
    mutationErrors: 0,
  };
}

function fakeDb() {
  let subscriber: ((delta: { all: unknown[] }) => void) | null = null;
  let unsubscribeCalls = 0;
  let rejectNextWrite: Error | null = null;
  const writes: Array<{ operation: "insert" | "update"; value: unknown }> = [];

  function handle() {
    return {
      wait: ({ tier }: { tier: "local" | "global" }) => {
        assert(tier === "local", "local-only tests must not request a global wait");
        if (rejectNextWrite) {
          const error = rejectNextWrite;
          rejectNextWrite = null;
          return Promise.reject(error);
        }
        return Promise.resolve();
      },
    };
  }

  const value = {
    subscribeAll(_collection: unknown, callback: (delta: { all: unknown[] }) => void) {
      subscriber = callback;
      return () => {
        unsubscribeCalls += 1;
        subscriber = null;
      };
    },
    insert(_collection: unknown, next: unknown) {
      writes.push({ operation: "insert", value: next });
      return handle();
    },
    update(_collection: unknown, id: string, next: unknown) {
      writes.push({ operation: "update", value: { id, next } });
      return handle();
    },
  } as unknown as Db;

  return {
    value,
    publish(all: unknown[]) {
      assert(subscriber, "expected an active vendor subscription");
      subscriber({ all });
    },
    failNextWrite(message: string) {
      rejectNextWrite = new Error(message);
    },
    writes,
    unsubscribeCalls: () => unsubscribeCalls,
  };
}

test("two consumers share one vendor subscription and clean up idempotently", () => {
  const db = fakeDb();
  const counts = diagnostics();
  const store = new NotesStore(db.value, counts);
  let firstUpdates = 0;
  let secondUpdates = 0;

  const stopFirst = store.subscribe(() => firstUpdates += 1);
  const stopSecond = store.subscribe(() => secondUpdates += 1);
  assertCount(counts.activeConsumers, 2, "both component consumers must be counted");
  assertCount(
    counts.activeVendorSubscriptions,
    1,
    "one query should have one vendor subscription",
  );
  assertCount(counts.totalVendorSubscriptions, 1, "the underlying query should open once");

  db.publish([{ id: "note-1", body: "shared", createdAt: new Date(0) }]);
  assert(store.getSnapshot().status === "ready", "the first query result must end loading");
  assert(store.getSnapshot().notes.length === 1, "the query result must be published");
  assert(firstUpdates > 0 && secondUpdates > 0, "both roots must receive reactive updates");

  stopFirst();
  assertCount(counts.activeConsumers, 1, "unmounting one root must leave the other active");
  assertCount(
    counts.activeVendorSubscriptions,
    1,
    "the remaining consumer must retain the query",
  );
  stopFirst();
  assertCount(counts.activeConsumers, 1, "unsubscribe must be idempotent");

  stopSecond();
  assertCount(counts.activeConsumers, 0, "the final unmount must remove all consumers");
  assertCount(counts.activeVendorSubscriptions, 0, "the final unmount must close the query");
  assertCount(db.unsubscribeCalls(), 1, "the vendor unsubscribe must run exactly once");
  assertCount(counts.unsubscribeCalls, 1, "cleanup must remain externally diagnosable");
});

test("local writes are awaited and failures remain visible", async () => {
  const db = fakeDb();
  const counts = diagnostics();
  const store = new NotesStore(db.value, counts);

  await store.add("first");
  await store.update("note-1", "edited");
  assert(counts.localWaitCalls === 2, "every accepted write must await local durability");
  assert(db.writes.length === 2, "insert and update must reach the vanilla Jazz boundary");
  assert(store.getSnapshot().durability === "local", "the UI may claim local after the wait");

  db.failNextWrite("disk full");
  let rejected = false;
  try {
    await store.add("cannot persist");
  } catch {
    rejected = true;
  }
  assert(rejected, "a failed local wait must reject the public mutation");
  assert(store.getSnapshot().status === "error", "a failed local wait must reach UI state");
  assert(store.getSnapshot().error === "disk full", "the durable-write cause must remain visible");
});

test("public mutation errors update observable diagnostics", () => {
  const db = fakeDb();
  const counts = diagnostics();
  const store = new NotesStore(db.value, counts);
  store.reportMutationError({
    code: "WriteRejected",
    reason: "permission denied",
  } as MutationErrorEvent);
  assert(counts.mutationErrors === 1, "mutation errors must be counted");
  assert(store.getSnapshot().error?.includes("permission denied"), "the reason must reach the UI");
});
