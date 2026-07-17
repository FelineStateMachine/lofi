import type { Db, MutationErrorEvent, TableProxy } from "jazz-tools";
import { schema as s } from "jazz-tools";
import { createDiagnostics } from "./diagnostics.ts";
import { type TableMutationEnvironment, TableMutationRegistry } from "./table-mutations.ts";
import { assert, assertCount } from "./test-assert.ts";

type Row = { id: string; title: string; archived: boolean };
type Init = Omit<Row, "id">;
const table = { _table: "records", _schema: {} } as TableProxy<Row, Init>;

class FakeDb {
  mutationListeners = new Set<(event: MutationErrorEvent) => void>();
  localWaits = 0;
  globalWaits = 0;
  failLocal: Error | null = null;
  nextId = 0;
  operations: string[] = [];

  value(): Db {
    return this as unknown as Db;
  }

  onMutationError(listener: (event: MutationErrorEvent) => void): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  insert(_table: TableProxy<Row, Init>, values: Init) {
    this.operations.push("insert");
    return this.handle({ id: `row-${++this.nextId}`, ...values });
  }

  update(_table: TableProxy<Row, Init>, _id: string, _patch: Partial<Init>) {
    this.operations.push("update");
    return this.handle(undefined);
  }

  delete(_table: TableProxy<Row, Init>, _id: string) {
    this.operations.push("delete");
    return this.handle(undefined);
  }

  reject(event: MutationErrorEvent): void {
    for (const listener of this.mutationListeners) listener(event);
  }

  private handle<T>(value: T) {
    return {
      wait: ({ tier }: { tier: "local" | "global" }) => {
        if (tier === "local") {
          this.localWaits += 1;
          if (this.failLocal) {
            const error = this.failLocal;
            this.failLocal = null;
            return Promise.reject(error);
          }
        } else {
          this.globalWaits += 1;
        }
        return Promise.resolve(value);
      },
    };
  }
}

function environment(db: FakeDb, syncConfigured = false) {
  const diagnostics = createDiagnostics();
  const recreation = new Set<() => void>();
  const value: TableMutationEnvironment = {
    getDb: () => Promise.resolve(db.value()),
    syncConfigured: () => syncConfigured,
    subscribeRuntimeRecreation(listener) {
      recreation.add(listener);
      return () => recreation.delete(listener);
    },
    updateDiagnostics(update) {
      update(diagnostics);
    },
  };
  return { value, diagnostics, recreation };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

Deno.test("table mutation consumers share one listener and release it after final teardown", async () => {
  const db = new FakeDb();
  const runtime = environment(db);
  const registry = new TableMutationRegistry(runtime.value);
  const first = registry.acquire(table);
  const second = registry.acquire(table);
  assert(first.store === second.store, "one table created duplicate mutation stores");
  const stopFirst = first.store.subscribe(() => undefined);
  const stopSecond = second.store.subscribe(() => undefined);
  await flush();
  assertCount(db.mutationListeners.size, 1, "one table opened duplicate mutation listeners");
  assertCount(runtime.diagnostics.activeMutationListeners, 1, "listener diagnostics drifted");
  stopFirst();
  first.release();
  assertCount(db.mutationListeners.size, 1, "one remaining consumer lost mutation errors");
  stopSecond();
  second.release();
  assertCount(db.mutationListeners.size, 0, "final teardown retained the mutation listener");
  assertCount(runtime.diagnostics.activeMutationListeners, 0, "listener diagnostics leaked");
});

Deno.test("typed mutations return inserted rows and wait for local durability", async () => {
  const db = new FakeDb();
  const runtime = environment(db);
  const store = new TableMutationRegistry(runtime.value).acquire(table).store;
  const created = await store.insert({ title: "created", archived: false });
  await store.update(created.id, { archived: true });
  await store.remove(created.id);
  assert(created.id === "row-1" && created.title === "created", "insert omitted the created row");
  assert(db.operations.join(",") === "insert,update,delete", "typed operations missed the DB");
  assertCount(db.localWaits, 3, "mutations resolved before local durability");
  assertCount(runtime.diagnostics.localWaitCalls, 3, "local waits were not diagnosable");
  assert(store.getSnapshot().durability === "local", "local durability was not observable");
});

Deno.test("managed mutations continue global durability tracking in the background", async () => {
  const db = new FakeDb();
  const runtime = environment(db, true);
  const store = new TableMutationRegistry(runtime.value).acquire(table).store;
  await store.insert({ title: "managed", archived: false });
  await flush();
  assertCount(db.globalWaits, 1, "managed mutation omitted its global wait");
  assert(store.getSnapshot().durability === "global", "global confirmation was not observable");
  assertCount(runtime.diagnostics.pendingGlobalWrites, 0, "global wait remained pending");
});

Deno.test("local and asynchronous permission rejections reach public mutation state", async () => {
  const db = new FakeDb();
  const runtime = environment(db);
  const lease = new TableMutationRegistry(runtime.value).acquire(table);
  const stop = lease.store.subscribe(() => undefined);
  await flush();
  db.failLocal = new Error("local permission denied");
  await lease.store.insert({ title: "blocked", archived: false }).catch(() => undefined);
  assert(lease.store.getSnapshot().error === "local permission denied", "local rejection hidden");
  db.reject({ code: "WriteRejected", reason: "revoked" } as MutationErrorEvent);
  assert(lease.store.getSnapshot().error?.includes("revoked"), "async rejection hidden");
  assertCount(runtime.diagnostics.mutationErrors, 2, "rejections were not diagnosed");
  stop();
  lease.release();
});

Deno.test("mutation types follow the exact Jazz table insert and row shapes", () => {
  const app = s.defineApp({ records: s.table({ title: s.string(), archived: s.boolean() }) });
  const registry = new TableMutationRegistry(environment(new FakeDb()).value);
  const lease = registry.acquire(app.records);
  const result: Promise<s.RowOf<typeof app.records>> = lease.store.insert({
    title: "typed",
    archived: false,
  });
  assert(result instanceof Promise, "typed insert did not return a promise");
  lease.release();
});
