import type { Db, MutationErrorEvent } from "jazz-tools";
// Package contract tests.
import { createDiagnostics, type RuntimeDiagnostics } from "./diagnostics.ts";
import { createTableStore, type TableHandle } from "./table-store.ts";
import { assert, assertCount } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

type Row = { id: string; text: string; completed: boolean; createdAt: Date };
type RowInit = Omit<Row, "id">;

const table = {} as unknown as TableHandle<Row, RowInit>;

function diagnostics(): RuntimeDiagnostics {
  return {
    ...createDiagnostics(),
    storageState: "persistent-driver-open",
    clientsCreated: 1,
    activeClients: 1,
  };
}

function fakeDb(options: { allowGlobal?: boolean } = {}) {
  let subscriber: ((delta: { all: unknown[] }) => void) | null = null;
  let unsubscribeCalls = 0;
  let rejectNextWrite: Error | null = null;
  let deferredNextWrite: {
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;
  let globalWaitCalls = 0;
  const writes: Array<{ operation: "insert" | "update" | "delete"; value: unknown }> = [];

  function handle() {
    const deferredWrite = deferredNextWrite;
    deferredNextWrite = null;
    return {
      wait: ({ tier }: { tier: "local" | "global" }) => {
        if (tier === "global") {
          globalWaitCalls += 1;
          if (!options.allowGlobal) {
            return Promise.reject(new Error("unconfigured stores must not request global waits"));
          }
          return Promise.resolve();
        }
        if (tier === "local" && rejectNextWrite) {
          const error = rejectNextWrite;
          rejectNextWrite = null;
          return Promise.reject(error);
        }
        if (tier === "local" && deferredWrite) return deferredWrite.promise;
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
    onMutationError(_callback: (event: MutationErrorEvent) => void) {
      return () => undefined;
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
    deferNextWrite() {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      deferredNextWrite = { promise, resolve, reject };
      return deferredNextWrite;
    },
    writes,
    globalWaitCalls: () => globalWaitCalls,
    unsubscribeCalls: () => unsubscribeCalls,
  };
}

test("two consumers share one table subscription and clean up idempotently", () => {
  const db = fakeDb();
  const counts = diagnostics();
  const store = createTableStore<Row, RowInit>(db.value, table, counts);
  let firstUpdates = 0;
  let secondUpdates = 0;

  const stopFirst = store.subscribe(() => firstUpdates += 1);
  const stopSecond = store.subscribe(() => secondUpdates += 1);
  assertCount(counts.activeConsumers, 2, "both component consumers must be counted");
  assertCount(counts.activeVendorSubscriptions, 1, "one query should have one subscription");
  assertCount(counts.totalVendorSubscriptions, 1, "the underlying query should open once");

  db.publish([{
    id: "row-1",
    text: "shared",
    completed: false,
    createdAt: new Date(0),
  }]);
  assert(store.getSnapshot().status === "ready", "the first query result must end loading");
  assert(store.getSnapshot().rows.length === 1, "the query result must be published");
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

test("every mutation exposes pending work and waits for local durability", async () => {
  const db = fakeDb();
  const counts = diagnostics();
  const store = createTableStore<Row, RowInit>(db.value, table, counts);

  const deferred = db.deferNextWrite();
  const first = store.insert({ text: "first", completed: false, createdAt: new Date(0) });
  await Promise.resolve();
  assertCount(counts.pendingLocalWrites, 1, "an unsettled local write must be observable");
  assert(String(counts.lastWriteDurability) === "none", "pending work must not claim durability");
  deferred.resolve();
  await first;
  assertCount(counts.pendingLocalWrites, 0, "a retained local write must leave no pending work");
  await store.update("row-1", { text: "edited" });
  await store.update("row-1", { completed: true });
  await store.delete("row-1");

  assertCount(counts.localWaitCalls, 4, "each accepted mutation must await local durability");
  assert(
    db.writes.map((write) => write.operation).join(",") === "insert,update,update,delete",
    "insert, edit, complete, and delete must reach the Jazz boundary",
  );
  assert(store.getSnapshot().durability === "local", "the UI may claim local after the wait");
  assert(
    String(counts.lastWriteDurability) === "local",
    "diagnostics must expose local durability",
  );
  assertCount(
    db.globalWaitCalls(),
    0,
    "an unconfigured store must never request global durability",
  );
});

test("configured sync advances the latest write from local to global durability", async () => {
  const db = fakeDb({ allowGlobal: true });
  const store = createTableStore<Row, RowInit>(db.value, table, diagnostics(), {
    syncConfigured: true,
  });
  await store.insert({ text: "sync after reconnect", completed: false, createdAt: new Date(0) });
  await Promise.resolve();
  assert(
    store.getSnapshot().durability === "global",
    "the public mutation handle must make completed global durability visible",
  );
  assertCount(db.globalWaitCalls(), 1, "configured sync must request global durability");
});

test("local write failures remain visible and reject the mutation", async () => {
  const db = fakeDb();
  const store = createTableStore<Row, RowInit>(db.value, table, diagnostics());
  db.failNextWrite("disk full");
  let rejected = false;
  try {
    await store.insert({ text: "cannot persist", completed: false, createdAt: new Date(0) });
  } catch {
    rejected = true;
  }
  assert(rejected, "a failed local wait must reject the public mutation");
  assert(store.getSnapshot().status === "error", "a failed local wait must reach UI state");
  assert(store.getSnapshot().error === "disk full", "the durable-write cause must remain visible");
});

test("a superseded local-write failure remains visible", async () => {
  const db = fakeDb();
  const counts = diagnostics();
  const store = createTableStore<Row, RowInit>(db.value, table, counts);
  const firstWrite = db.deferNextWrite();

  const firstMutation = store.insert({ text: "first", completed: false, createdAt: new Date(0) });
  await Promise.resolve();
  await store.insert({ text: "newer", completed: false, createdAt: new Date(0) });
  firstWrite.reject(new Error("first write lost"));

  let rejected = false;
  try {
    await firstMutation;
  } catch {
    rejected = true;
  }
  assert(rejected, "the superseded mutation promise must still reject");
  assert(store.getSnapshot().status === "error", "the stale rejection must reach UI state");
  assert(store.getSnapshot().durability === "failed", "the stale rejection must be durable state");
  assert(store.getSnapshot().error === "first write lost", "the stale cause must remain visible");
  assertCount(counts.mutationErrors, 1, "the stale failure must remain diagnosable");
});

test("retrying after failure clears the error status immediately", async () => {
  const db = fakeDb();
  const store = createTableStore<Row, RowInit>(db.value, table, diagnostics());
  db.failNextWrite("disk full");
  await store.insert({ text: "fails", completed: false, createdAt: new Date(0) }).catch(() =>
    undefined
  );
  const retryWrite = db.deferNextWrite();

  const retry = store.insert({ text: "retry", completed: false, createdAt: new Date(0) });
  await Promise.resolve();
  assert(store.getSnapshot().status === "ready", "retry must leave the failed list status");
  assert(store.getSnapshot().error === null, "retry must not render a null error message");
  assert(store.getSnapshot().durability === "none", "retry is pending until local durability");
  retryWrite.resolve();
  await retry;
});

test("public mutation errors update observable diagnostics", () => {
  const counts = diagnostics();
  const store = createTableStore<Row, RowInit>(fakeDb().value, table, counts);
  store.reportMutationError({
    code: "WriteRejected",
    reason: "permission denied",
  } as MutationErrorEvent);
  assertCount(counts.mutationErrors, 1, "mutation errors must be counted");
  assert(store.getSnapshot().error?.includes("permission denied"), "the reason must reach the UI");
});
