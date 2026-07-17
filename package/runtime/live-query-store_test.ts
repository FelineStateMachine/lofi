import type { Db, QueryBuilder } from "jazz-tools";
import { schema as s } from "jazz-tools";
import { createDiagnostics } from "./diagnostics.ts";
import {
  type LiveQueryEnvironment,
  LiveQueryRegistry,
  type LiveQuerySnapshot,
} from "./live-query-store.ts";
import { assert, assertCount } from "./test-assert.ts";

type Row = { id: string; title: string };

function query(
  schema: object,
  plan: Record<string, unknown>,
): QueryBuilder<Row> {
  return {
    _table: String(plan.table ?? "records"),
    _schema: schema,
    _build: () => JSON.stringify(plan),
  } as QueryBuilder<Row>;
}

class FakeDb {
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  throwOnSubscribe: Error | null = null;
  readonly callbacks = new Set<(rows: Row[]) => void>();

  value(): Pick<Db, "subscribeAll"> {
    return this as unknown as Pick<Db, "subscribeAll">;
  }

  subscribeAll(
    _query: QueryBuilder<Row>,
    callback: (delta: { all: Row[] }) => void,
  ): () => void {
    if (this.throwOnSubscribe) throw this.throwOnSubscribe;
    this.subscribeCalls += 1;
    const publish = (rows: Row[]) => callback({ all: rows });
    this.callbacks.add(publish);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.callbacks.delete(publish);
      this.unsubscribeCalls += 1;
    };
  }

  publish(rows: Row[]): void {
    for (const callback of this.callbacks) callback(rows);
  }
}

function testEnvironment(db: FakeDb, diagnostics = createDiagnostics()) {
  const recreationListeners = new Set<() => void>();
  const environment: LiveQueryEnvironment = {
    getDb: () => Promise.resolve(db.value()),
    subscribeRuntimeRecreation(listener) {
      recreationListeners.add(listener);
      return () => recreationListeners.delete(listener);
    },
    updateDiagnostics(update) {
      update(diagnostics);
    },
  };
  return {
    environment,
    diagnostics,
    recreate() {
      for (const listener of recreationListeners) listener();
    },
    recreationListeners,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

Deno.test("equivalent queries share one subscription and final release evicts the store", async () => {
  const db = new FakeDb();
  const runtime = testEnvironment(db);
  const registry = new LiveQueryRegistry(runtime.environment);
  const schema = {};
  const first = registry.acquire(query(schema, {
    table: "records",
    conditions: [{ column: "archived", op: "eq", value: false }],
    includes: { owner: true, comments: true },
  }));
  const second = registry.acquire(query(schema, {
    includes: { comments: true, owner: true },
    conditions: [{ value: false, op: "eq", column: "archived" }],
    table: "records",
  }));
  assert(first.store === second.store, "stable query serialization did not deduplicate stores");

  let firstUpdates = 0;
  let secondUpdates = 0;
  const stopFirst = first.store.subscribe(() => firstUpdates += 1);
  const stopSecond = second.store.subscribe(() => secondUpdates += 1);
  await flush();
  assertCount(db.subscribeCalls, 1, "equivalent consumers opened duplicate vendor subscriptions");
  assertCount(runtime.diagnostics.activeConsumers, 2, "mounted consumers were not counted");
  db.publish([]);
  assert(first.store.getSnapshot().status === "ready", "an empty result remained loading");
  db.publish([{ id: "row-1", title: "shared" }]);
  assert(firstUpdates > 1 && secondUpdates > 1, "shared rows did not reach both consumers");

  stopFirst();
  first.release();
  assertCount(db.unsubscribeCalls, 0, "one remaining consumer lost its shared subscription");
  stopSecond();
  second.release();
  assertCount(db.unsubscribeCalls, 1, "the final consumer did not close the vendor subscription");
  assertCount(runtime.diagnostics.activeConsumers, 0, "consumer diagnostics leaked after teardown");

  const replacement = registry.acquire(query(schema, {
    table: "records",
    conditions: [{ column: "archived", op: "eq", value: false }],
    includes: { owner: true, comments: true },
  }));
  assert(replacement.store !== first.store, "the final release retained an obsolete query store");
  replacement.release();
});

Deno.test("identical query plans from different schemas never share a store", () => {
  const registry = new LiveQueryRegistry(testEnvironment(new FakeDb()).environment);
  const first = registry.acquire(query({}, { table: "records" }));
  const second = registry.acquire(query({}, { table: "records" }));
  assert(first.store !== second.store, "query identity crossed schema boundaries");
  first.release();
  second.release();
});

Deno.test("changing query dependencies closes the obsolete query before opening the next", async () => {
  const db = new FakeDb();
  const registry = new LiveQueryRegistry(testEnvironment(db).environment);
  const schema = {};
  const first = registry.acquire(query(schema, {
    table: "records",
    conditions: [{ column: "workspaceId", op: "eq", value: "one" }],
  }));
  const stopFirst = first.store.subscribe(() => undefined);
  await flush();
  stopFirst();
  first.release();
  assertCount(db.unsubscribeCalls, 1, "obsolete dependency retained its subscription");

  const second = registry.acquire(query(schema, {
    table: "records",
    conditions: [{ column: "workspaceId", op: "eq", value: "two" }],
  }));
  const stopSecond = second.store.subscribe(() => undefined);
  await flush();
  assertCount(db.subscribeCalls, 2, "new dependency did not open its query");
  stopSecond();
  second.release();
});

Deno.test("synchronous vendor setup errors become stable query read state", async () => {
  const db = new FakeDb();
  db.throwOnSubscribe = new Error("query setup failed");
  const registry = new LiveQueryRegistry(testEnvironment(db).environment);
  const lease = registry.acquire(query({}, { table: "records" }));
  const stop = lease.store.subscribe(() => undefined);
  await flush();
  const snapshot = lease.store.getSnapshot();
  assert(snapshot.status === "error", "synchronous setup failure left the query loading");
  assert(snapshot.rows.length === 0, "failed setup retained stale rows");
  assert(snapshot.error === "query setup failed", "setup failure was hidden");
  stop();
  lease.release();
});

Deno.test("runtime recreation ignores stale async clients and reconnects mounted queries", async () => {
  const diagnostics = createDiagnostics();
  const recreationListeners = new Set<() => void>();
  const pending: Array<(db: Pick<Db, "subscribeAll">) => void> = [];
  const environment: LiveQueryEnvironment = {
    getDb: () => new Promise((resolve) => pending.push(resolve)),
    subscribeRuntimeRecreation(listener) {
      recreationListeners.add(listener);
      return () => recreationListeners.delete(listener);
    },
    updateDiagnostics(update) {
      update(diagnostics);
    },
  };
  const registry = new LiveQueryRegistry(environment);
  const lease = registry.acquire(query({}, { table: "records" }));
  let updates = 0;
  const stop = lease.store.subscribe(() => updates += 1);
  assertCount(pending.length, 1, "initial runtime acquisition did not start");
  for (const listener of recreationListeners) listener();
  assertCount(pending.length, 2, "recreation did not request the replacement runtime");

  const obsolete = new FakeDb();
  const replacement = new FakeDb();
  pending[1]!(replacement.value());
  await flush();
  pending[0]!(obsolete.value());
  await flush();
  assertCount(obsolete.subscribeCalls, 0, "stale runtime won the recreation race");
  assertCount(replacement.subscribeCalls, 1, "replacement runtime did not receive the query");
  replacement.publish([{ id: "row-new", title: "replacement" }]);
  const latest: LiveQuerySnapshot<Row> = lease.store.getSnapshot();
  assert(latest.rows[0]?.id === "row-new", "replacement rows did not reach the mounted query");
  assert(updates > 1, "replacement rows did not notify the mounted consumer");

  stop();
  lease.release();
});

Deno.test("registry disposal releases active HMR-owned resources", async () => {
  const db = new FakeDb();
  const runtime = testEnvironment(db);
  const registry = new LiveQueryRegistry(runtime.environment);
  const lease = registry.acquire(query({}, { table: "records" }));
  const stop = lease.store.subscribe(() => undefined);
  await flush();
  registry.dispose();
  assertCount(db.unsubscribeCalls, 1, "registry disposal retained the vendor subscription");
  assertCount(runtime.diagnostics.activeConsumers, 0, "registry disposal retained consumers");
  assertCount(runtime.recreationListeners.size, 0, "registry disposal retained event listeners");
  stop();
  lease.release();
});

Deno.test("query row projections remain inferred from the exact Jazz builder", () => {
  const app = s.defineApp({ records: s.table({ title: s.string(), archived: s.boolean() }) });
  const registry = new LiveQueryRegistry(testEnvironment(new FakeDb()).environment);
  const lease = registry.acquire(app.records.select("title"));
  const row = lease.store.getSnapshot().rows[0];
  const title: string | undefined = row?.title;
  assert(title === undefined, "an unsubscribed projection unexpectedly produced a row");
  // @ts-expect-error select("title") must not retain unselected application columns.
  row?.archived;
  lease.release();
});
