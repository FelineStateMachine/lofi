import type { Db, MutationErrorEvent } from "jazz-tools";
import { ChecklistStore, type RuntimeDiagnostics } from "./checklist-store.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertCount(actual: number, expected: number, message: string): void {
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
  const writes: Array<{ operation: "insert" | "update" | "delete"; value: unknown }> = [];

  function handle() {
    return {
      wait: ({ tier }: { tier: "local" | "global" }) => {
        if (tier === "local" && rejectNextWrite) {
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
    delete(_collection: unknown, id: string) {
      writes.push({ operation: "delete", value: id });
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

test("two consumers share one task subscription and clean up idempotently", () => {
  const db = fakeDb();
  const counts = diagnostics();
  const store = new ChecklistStore(db.value, counts);
  let firstUpdates = 0;
  let secondUpdates = 0;

  const stopFirst = store.subscribe(() => firstUpdates += 1);
  const stopSecond = store.subscribe(() => secondUpdates += 1);
  assertCount(counts.activeConsumers, 2, "both component consumers must be counted");
  assertCount(counts.activeVendorSubscriptions, 1, "one query should have one subscription");
  assertCount(counts.totalVendorSubscriptions, 1, "the underlying query should open once");

  db.publish([{
    id: "task-1",
    text: "shared",
    completed: false,
    createdAt: new Date(0),
  }]);
  assert(store.getSnapshot().status === "ready", "the first query result must end loading");
  assert(store.getSnapshot().tasks.length === 1, "the query result must be published");
  assert(firstUpdates > 0 && secondUpdates > 0, "both roots must receive reactive updates");

  stopFirst();
  assertCount(counts.activeConsumers, 1, "unmounting one root must leave the other active");
  assertCount(counts.activeVendorSubscriptions, 1, "the remaining consumer retains the query");
  stopFirst();
  assertCount(counts.activeConsumers, 1, "unsubscribe must be idempotent");
  stopSecond();
  assertCount(counts.activeConsumers, 0, "the final unmount must remove all consumers");
  assertCount(counts.activeVendorSubscriptions, 0, "the final unmount must close the query");
  assertCount(db.unsubscribeCalls(), 1, "the vendor unsubscribe must run exactly once");
  assertCount(counts.unsubscribeCalls, 1, "cleanup must remain externally diagnosable");
});

test("every checklist mutation waits for local durability", async () => {
  const db = fakeDb();
  const counts = diagnostics();
  const store = new ChecklistStore(db.value, counts);

  await store.create("first");
  await store.update("task-1", "edited");
  await store.setCompleted("task-1", true);
  await store.delete("task-1");

  assertCount(counts.localWaitCalls, 4, "each accepted mutation must await local durability");
  assert(
    db.writes.map((write) => write.operation).join(",") === "insert,update,update,delete",
    "create, edit, complete, and delete must reach the Jazz boundary",
  );
  assert(store.getSnapshot().durability === "local", "the UI may claim local after the wait");
});

test("configured sync advances the latest write from local to global durability", async () => {
  const store = new ChecklistStore(fakeDb().value, diagnostics(), true);
  await store.create("sync after reconnect");
  await Promise.resolve();
  assert(
    store.getSnapshot().durability === "global",
    "the public mutation handle must make completed global durability visible",
  );
});

test("local write failures remain visible and reject the mutation", async () => {
  const db = fakeDb();
  const store = new ChecklistStore(db.value, diagnostics());
  db.failNextWrite("disk full");
  let rejected = false;
  try {
    await store.create("cannot persist");
  } catch {
    rejected = true;
  }
  assert(rejected, "a failed local wait must reject the public mutation");
  assert(store.getSnapshot().status === "error", "a failed local wait must reach UI state");
  assert(store.getSnapshot().error === "disk full", "the durable-write cause must remain visible");
});

test("public mutation errors update observable diagnostics", () => {
  const counts = diagnostics();
  const store = new ChecklistStore(fakeDb().value, counts);
  store.reportMutationError({
    code: "WriteRejected",
    reason: "permission denied",
  } as MutationErrorEvent);
  assertCount(counts.mutationErrors, 1, "mutation errors must be counted");
  assert(store.getSnapshot().error?.includes("permission denied"), "the reason must reach the UI");
});
