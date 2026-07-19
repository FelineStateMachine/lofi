import type { Db, MutationErrorEvent, TableProxy } from "jazz-tools";
import { createDiagnostics } from "./diagnostics.ts";
import type { EffectContext, EffectUnit } from "../schema/effects.ts";
import { assert, assertCount } from "./test-assert.ts";
import {
  createMemoryJournalStorage,
  emptyJournal,
  hashJournalValue,
  type JournalDocument,
  journalIdFor,
} from "./write-journal.ts";
import { WriteLedger, type WriteLedgerEnvironment } from "./write-ledger.ts";

type Row = { id: string; title: string };
type Init = Omit<Row, "id">;
const table = { _table: "records", _schema: {} } as TableProxy<Row, Init>;

class FakeRejection extends Error {
  override readonly name = "PersistedWriteRejectedError";
  constructor(readonly code: string, readonly reason: string) {
    super(`${code}: ${reason}`);
  }
}

type Deferred = { resolve(): void; reject(error: unknown): void };

class FakeDb {
  mutationListeners = new Set<(event: MutationErrorEvent) => void>();
  globalWaits: Deferred[] = [];
  rows: Array<Record<string, unknown>> = [];
  refuseNext: Error | null = null;
  nextId = 0;
  nextBatch = 0;
  reads = 0;

  value(): Db {
    return this as unknown as Db;
  }

  onMutationError(listener: (event: MutationErrorEvent) => void): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  emit(event: MutationErrorEvent): void {
    for (const listener of this.mutationListeners) listener(event);
  }

  insert(_table: TableProxy<Row, Init>, values: Init) {
    if (this.refuseNext) {
      const error = this.refuseNext;
      this.refuseNext = null;
      throw error;
    }
    const row = { id: `row-${++this.nextId}`, ...values };
    return { value: row, ...this.handle() };
  }

  update(_table: TableProxy<Row, Init>, _id: string, _patch: Partial<Init>) {
    return this.handle();
  }

  delete(_table: TableProxy<Row, Init>, _id: string) {
    return this.handle();
  }

  all(): Promise<unknown[]> {
    this.reads += 1;
    return Promise.resolve(this.rows);
  }

  settleGlobal(index = 0): void {
    this.globalWaits[index]?.resolve();
  }

  rejectGlobal(error: unknown, index = 0): void {
    this.globalWaits[index]?.reject(error);
  }

  private handle() {
    return {
      batchId: `batch-${++this.nextBatch}`,
      wait: ({ tier }: { tier: "local" | "global" }) => {
        if (tier === "local") return Promise.resolve(undefined);
        return new Promise<unknown>((resolve, reject) => {
          this.globalWaits.push({ resolve: () => resolve(undefined), reject });
        });
      },
    };
  }
}

type Harness = {
  db: FakeDb;
  ledger: WriteLedger;
  diagnostics: ReturnType<typeof createDiagnostics>;
  storage: ReturnType<typeof createMemoryJournalStorage>;
  units: Map<string, EffectUnit<{ id: string }>>;
  clock: { value: number };
};

function harness(options: {
  syncConfigured?: boolean;
  storage?: ReturnType<typeof createMemoryJournalStorage>;
  units?: Map<string, EffectUnit<{ id: string }>>;
  db?: FakeDb;
  guardWrite?: () => Promise<(() => void) | void>;
  sweepIntervalMs?: number;
} = {}): Harness {
  const db = options.db ?? new FakeDb();
  const diagnostics = createDiagnostics();
  const storage = options.storage ?? createMemoryJournalStorage();
  const units = options.units ?? new Map<string, EffectUnit<{ id: string }>>();
  const clock = { value: 1000 };
  const environment: WriteLedgerEnvironment = {
    getDb: () => Promise.resolve(db.value()),
    syncConfigured: () => options.syncConfigured ?? true,
    storage,
    resolveTable: (name) => (name === "records" ? { where: (input) => input } : null),
    resolveEffectUnit: (name) => units.get(name) ?? null,
    subscribeRuntimeRecreation: () => () => undefined,
    updateDiagnostics: (update) => update(diagnostics),
    now: () => clock.value,
    retryDelayMs: () => 1,
    probeTimeoutMs: 50,
    sweepIntervalMs: options.sweepIntervalMs ?? 60_000,
    ...(options.guardWrite ? { guardWrite: options.guardWrite } : {}),
  };
  return { db, ledger: new WriteLedger(environment), diagnostics, storage, units, clock };
}

function unit(
  name: string,
  calls: Array<{ handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }>,
  options: {
    failFirst?: { onSynced?: boolean };
    failAlways?: boolean;
    expiresAfterMs?: number;
    maxAttempts?: number;
  } = {},
): EffectUnit<{ id: string }> {
  let failed = false;
  return {
    effectName: name,
    handlers: {
      onSynced: (row, context) => {
        if (options.failAlways) throw new Error("handler always explodes");
        if (options.failFirst?.onSynced && !failed) {
          failed = true;
          throw new Error("handler exploded");
        }
        calls.push({ handler: "onSynced", row, context });
      },
      onRejected: (row, context) => {
        calls.push({ handler: "onRejected", row, context });
      },
    },
    expiresAfterMs: options.expiresAfterMs ?? null,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function settleTimers(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("a verb write progresses saved to synced and fires onSynced exactly once", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["chargeCard", unit("chargeCard", calls)]]);
  const fixture = harness({ units });
  await fixture.ledger.arm();
  const handle = fixture.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "one" } },
    { verb: "placeOrder", units: [units.get("chargeCard")!] },
  );
  const row = await handle;
  assert(row.title === "one", "await must resolve the created row at saved");
  assert(handle.stage === "saved", "the write must rest at saved until the store confirms");
  assertCount(fixture.ledger.getPendingSnapshot().count, 1, "a saved write must count as pending");
  assert(fixture.ledger.rowStatus(row.id) === "waiting", "an unsettled row must read waiting");
  fixture.db.settleGlobal();
  await flush();
  assert(String(handle.stage) === "synced", "store confirmation must reach the handle");
  assertCount(calls.length, 1, "onSynced must fire exactly once");
  assert(calls[0].handler === "onSynced", "confirmation must run the action handler");
  assert(
    calls[0].context.journalId === journalIdFor(handle.writeId, "chargeCard"),
    "the handler must receive the (write id, effect name) idempotency key",
  );
  assertCount(fixture.ledger.getPendingSnapshot().count, 0, "a settled write must leave pending");
  assert(fixture.ledger.rowStatus(row.id) === "synced", "a confirmed row must read synced");
  await fixture.ledger.flush();
  assert(fixture.storage.text()?.includes(handle.writeId) === false, "settled entries must prune");
  fixture.ledger.dispose();
});

Deno.test("a synchronous local refusal throws from the call and never journals", async () => {
  const fixture = harness();
  await fixture.ledger.arm();
  fixture.db.refuseNext = new Error("current policy refuses this write");
  let thrown: Error | null = null;
  try {
    fixture.ledger.perform<Row>(
      { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "no" } },
    );
  } catch (error) {
    thrown = error as Error;
  }
  assert(thrown?.message === "current policy refuses this write", "the refusal must throw");
  assertCount(fixture.ledger.getPendingSnapshot().count, 0, "a refusal must not journal");
  await fixture.ledger.flush();
  assert(
    (fixture.storage.text() ?? "").includes("records") === false,
    "a refusal must leave no journal entry",
  );
  assertCount(fixture.diagnostics.mutationErrors, 1, "the refusal must still be diagnosable");
  fixture.ledger.dispose();
});

Deno.test("a permanent verdict settles rejected and fires onRejected exactly once", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["chargeCard", unit("chargeCard", calls)]]);
  const fixture = harness({ units });
  await fixture.ledger.arm();
  const handle = fixture.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "denied" } },
    { verb: "placeOrder", units: [units.get("chargeCard")!] },
  );
  const row = await handle;
  fixture.db.rejectGlobal(new FakeRejection("permission_denied", "policy tightened"));
  await flush();
  assert(handle.stage === "rejected", "a permanent verdict must settle the stage");
  assert(handle.reason?.code === "permission_denied", "the verdict code must be readable");
  assertCount(calls.length, 1, "onRejected must fire exactly once");
  assert(calls[0].handler === "onRejected", "compensation must run, not the action");
  assert(calls[0].context.fate === "rejected", "the handler must see the rejected fate");
  assert(fixture.ledger.rowStatus(row.id) === "rejected", "the row must read rejected");
  assertCount(fixture.ledger.getPendingSnapshot().count, 0, "a rejected write is not pending");
  fixture.ledger.dispose();
});

Deno.test("a transient failure keeps the write pending and never compensates", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["chargeCard", unit("chargeCard", calls)]]);
  const fixture = harness({ units });
  await fixture.ledger.arm();
  const handle = fixture.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "slow" } },
    { units: [units.get("chargeCard")!] },
  );
  await handle;
  fixture.db.rejectGlobal(new FakeRejection("mystery_code", "unknown"));
  await flush();
  assert(handle.stage === "saved", "an uninterpretable code must keep the write pending");
  assertCount(calls.length, 0, "no compensation on a non-permanent code");
  assertCount(fixture.ledger.getPendingSnapshot().count, 1, "the write must stay pending");
  // The scheduled re-derivation asks the store again; confirm it settles.
  await settleTimers();
  fixture.db.settleGlobal(1);
  await flush();
  assert(String(handle.stage) === "synced", "a later confirmation must settle the pending write");
  assertCount(calls.filter((call) => call.handler === "onSynced").length, 1, "then onSynced runs");
  fixture.ledger.dispose();
});

Deno.test("reload re-arm: journaled obligations fire after the journal is reloaded", async () => {
  const storage = createMemoryJournalStorage();
  // First run: the write settles as synced, but the unit is not registered
  // yet (its declaring module never loaded), so the obligation stays pending.
  const first = harness({ storage });
  await first.ledger.arm();
  const handle = first.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "kept" } },
    {
      verb: "placeOrder",
      units: [{ effectName: "notify", handlers: {} } as EffectUnit<{ id: string }>],
    },
  );
  await handle;
  first.db.settleGlobal();
  await flush();
  await first.ledger.flush();
  first.ledger.dispose();
  assert(
    (storage.text() ?? "").includes(handle.writeId),
    "the unsatisfied obligation must survive in the persisted journal",
  );

  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["notify", unit("notify", calls)]]);
  const second = harness({ storage, units });
  await second.ledger.arm();
  await flush();
  assertCount(calls.length, 1, "the reloaded runtime must re-run the journaled obligation");
  assert(calls[0].handler === "onSynced", "the synced fate must run the action handler");
  assert(
    calls[0].context.journalId === journalIdFor(handle.writeId, "notify"),
    "the idempotency key must survive the reload",
  );
  await second.ledger.flush();
  assert((second.storage.text() ?? "").includes(handle.writeId) === false, "then the entry prunes");
  second.ledger.dispose();
});

Deno.test("boot reconciliation confirms journaled writes against store state", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["celebrate", unit("celebrate", calls)]]);
  const document: JournalDocument = emptyJournal();
  document.writes["w-confirmed"] = {
    writeId: "w-confirmed",
    verb: "addTask",
    table: "records",
    op: "insert",
    rowId: "row-a",
    batchId: "batch-a",
    rowHashes: { title: hashJournalValue(document.hashKey, "kept") },
    stage: "saved",
    cause: null,
    code: null,
    reason: null,
    createdAt: 1,
    expiresAt: null,
    effects: {
      celebrate: { status: "pending", attempts: 0, lastError: null, expiresAt: null },
    },
  };
  document.writes["w-waiting"] = {
    writeId: "w-waiting",
    verb: null,
    table: "records",
    op: "insert",
    rowId: "row-b",
    batchId: "batch-b",
    rowHashes: { title: hashJournalValue(document.hashKey, "not there yet") },
    stage: "saved",
    cause: null,
    code: null,
    reason: null,
    createdAt: 2,
    expiresAt: null,
    effects: {},
  };
  const storage = createMemoryJournalStorage(JSON.stringify(document));
  const fixture = harness({ storage, units });
  fixture.db.rows = [{ id: "row-a", title: "kept" }];
  await fixture.ledger.arm();
  await flush();
  await settleTimers();
  assert(
    fixture.ledger.rowStatus("row-a") === "synced",
    "a journaled write the store confirms must settle as synced at boot",
  );
  assertCount(calls.length, 1, "the re-armed effect must fire after the store confirms");
  assert(
    fixture.ledger.rowStatus("row-b") === "waiting",
    "a journaled write the store does not confirm must stay pending",
  );
  assertCount(fixture.ledger.getPendingSnapshot().count, 1, "only the unconfirmed write pends");
  fixture.ledger.dispose();
});

Deno.test("boot reconciliation applies replayed verdicts to journaled writes", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["compensate", unit("compensate", calls)]]);
  const document: JournalDocument = emptyJournal();
  document.writes["w-denied"] = {
    writeId: "w-denied",
    verb: "addTask",
    table: "records",
    op: "insert",
    rowId: "row-x",
    batchId: "batch-x",
    rowHashes: { title: hashJournalValue(document.hashKey, "denied") },
    stage: "saved",
    cause: null,
    code: null,
    reason: null,
    createdAt: 1,
    expiresAt: null,
    effects: {
      compensate: { status: "pending", attempts: 0, lastError: null, expiresAt: null },
    },
  };
  const storage = createMemoryJournalStorage(JSON.stringify(document));
  const fixture = harness({ storage, units });
  await fixture.ledger.arm();
  fixture.db.emit(
    {
      code: "permission_denied",
      reason: "policy tightened while offline",
      batch: { batchId: "batch-x" },
    } as unknown as MutationErrorEvent,
  );
  await flush();
  assertCount(calls.length, 1, "the replayed verdict must run compensation once");
  assert(calls[0].handler === "onRejected", "a permanent verdict runs onRejected");
  assert(fixture.ledger.rowStatus("row-x") === "rejected", "the row must read rejected");
  fixture.db.emit(
    {
      code: "permission_denied",
      reason: "duplicate replay",
      batch: { batchId: "batch-x" },
    } as unknown as MutationErrorEvent,
  );
  await flush();
  assertCount(calls.length, 1, "a duplicate verdict must be recorded idempotently");
  fixture.ledger.dispose();
});

Deno.test("an unknown replayed code keeps the journaled write pending", async () => {
  const document: JournalDocument = emptyJournal();
  document.writes["w-odd"] = {
    writeId: "w-odd",
    verb: null,
    table: "records",
    op: "update",
    rowId: "row-y",
    batchId: "batch-y",
    rowHashes: { title: hashJournalValue(document.hashKey, "edited") },
    stage: "saved",
    cause: null,
    code: null,
    reason: null,
    createdAt: 1,
    expiresAt: null,
    effects: {},
  };
  const storage = createMemoryJournalStorage(JSON.stringify(document));
  const fixture = harness({ storage });
  await fixture.ledger.arm();
  fixture.db.emit(
    {
      code: "mystery",
      reason: "unclassifiable",
      batch: { batchId: "batch-y" },
    } as unknown as MutationErrorEvent,
  );
  await flush();
  assert(
    fixture.ledger.rowStatus("row-y") === "waiting",
    "an uninterpretable code must never settle or compensate a write",
  );
  fixture.ledger.dispose();
});

Deno.test("a remove is confirmed at boot by the row's absence", async () => {
  const document: JournalDocument = emptyJournal();
  document.writes["w-gone"] = {
    writeId: "w-gone",
    verb: null,
    table: "records",
    op: "remove",
    rowId: "row-z",
    batchId: "batch-z",
    rowHashes: {},
    stage: "saved",
    cause: null,
    code: null,
    reason: null,
    createdAt: 1,
    expiresAt: null,
    effects: {},
  };
  const storage = createMemoryJournalStorage(JSON.stringify(document));
  const fixture = harness({ storage });
  fixture.db.rows = [];
  await fixture.ledger.arm();
  await flush();
  await settleTimers();
  assertCount(fixture.ledger.getPendingSnapshot().count, 0, "the absent row confirms the remove");
  fixture.ledger.dispose();
});

Deno.test("effect units are independent: one failing handler never blocks another", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map<string, EffectUnit<{ id: string }>>([
    ["fragile", unit("fragile", calls, { failFirst: { onSynced: true } })],
    ["sturdy", unit("sturdy", calls)],
  ]);
  const fixture = harness({ units });
  await fixture.ledger.arm();
  const handle = fixture.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "both" } },
    { units: [units.get("fragile")!, units.get("sturdy")!] },
  );
  await handle;
  fixture.db.settleGlobal();
  await flush();
  assertCount(
    calls.filter((call) => call.handler === "onSynced").length,
    1,
    "the sturdy unit must run even though the fragile one failed",
  );
  assertCount(fixture.diagnostics.effectHandlerFailures, 1, "the failure must be diagnosable");
  await fixture.ledger.flush();
  assert(
    (fixture.storage.text() ?? "").includes("fragile"),
    "the failed obligation must stay journaled so the next boot re-arms it",
  );
  fixture.ledger.dispose();
});

Deno.test("without configured sync, local durability is settlement and effects run", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["local-note", unit("local-note", calls)]]);
  const fixture = harness({ syncConfigured: false, units });
  await fixture.ledger.arm();
  const handle = fixture.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "solo" } },
    { units: [units.get("local-note")!] },
  );
  await handle;
  await flush();
  assert(handle.stage === "synced", "a device without a sync location settles at saved");
  assertCount(calls.length, 1, "effects must run when the write settles");
  assertCount(fixture.ledger.getPendingSnapshot().count, 0, "nothing waits without a store");
  fixture.ledger.dispose();
});

Deno.test("a write-guard refusal fails the handle and never journals or compensates", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["chargeCard", unit("chargeCard", calls)]]);
  const fixture = harness({
    units,
    guardWrite: () => Promise.reject(new Error("schema is ahead of this bundle")),
  });
  await fixture.ledger.arm();
  const handle = fixture.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "held" } },
    { verb: "placeOrder", units: [units.get("chargeCard")!] },
  );
  const error = await handle.saved.then(() => null, (thrown) => thrown as Error);
  assert(
    error?.message === "schema is ahead of this bundle",
    "the guard refusal must surface through the verb call",
  );
  assert(handle.stage !== "rejected", "a refusal is not an adjudicated verdict");
  assertCount(fixture.ledger.getPendingSnapshot().count, 0, "a refused write must not journal");
  await fixture.ledger.flush();
  assert(
    (fixture.storage.text() ?? "").includes("held") === false,
    "a refused write must leave no journal entry",
  );
  assertCount(calls.length, 0, "a refused write must fire no effect");
  assertCount(fixture.diagnostics.mutationErrors, 1, "the refusal must be diagnosable");
  assertCount(fixture.db.nextId, 0, "the write must never reach the database");
  fixture.ledger.dispose();
});

Deno.test("the write-guard release covers exactly the local-durability window", async () => {
  let released = 0;
  const fixture = harness({
    guardWrite: () => Promise.resolve(() => void (released += 1)),
  });
  await fixture.ledger.arm();
  const handle = fixture.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "locked" } },
  );
  await handle;
  await flush();
  assertCount(released, 1, "the lock must release once the write settles locally");
  fixture.db.settleGlobal();
  await flush();
  assertCount(released, 1, "global settlement must not release the lock again");
  fixture.ledger.dispose();
});

Deno.test("the serialized journal holds hashes, never plaintext column values", async () => {
  const fixture = harness();
  await fixture.ledger.arm();
  const handle = fixture.ledger.perform<Row>(
    {
      kind: "insert",
      table: table as TableProxy<unknown, unknown>,
      values: { title: "SECRET-VALUE-XYZ" },
    },
  );
  await handle;
  await fixture.ledger.flush();
  const persisted = fixture.storage.text() ?? "";
  assert(persisted.includes(handle.writeId), "the pending write must be journaled");
  assert(
    persisted.includes("SECRET-VALUE-XYZ") === false,
    "no plaintext column value may reach the persisted journal",
  );
  assert(persisted.includes("rowHashes"), "the equality-probe hashes must be journaled");
  fixture.ledger.dispose();
});

Deno.test("boot compensation receives write identity only; live handlers keep the row", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["compensate", unit("compensate", calls)]]);
  const document: JournalDocument = emptyJournal();
  document.writes["w-back"] = {
    writeId: "w-back",
    verb: "placeOrder",
    table: "records",
    op: "insert",
    rowId: "row-q",
    batchId: "batch-q",
    rowHashes: { title: hashJournalValue(document.hashKey, "gone") },
    stage: "saved",
    cause: null,
    code: null,
    reason: null,
    createdAt: 1,
    expiresAt: null,
    effects: {
      compensate: { status: "pending", attempts: 0, lastError: null, expiresAt: null },
    },
  };
  const storage = createMemoryJournalStorage(JSON.stringify(document));
  const fixture = harness({ storage, units });
  await fixture.ledger.arm();
  fixture.db.emit(
    {
      code: "permission_denied",
      reason: "tightened while away",
      batch: { batchId: "batch-q" },
    } as unknown as MutationErrorEvent,
  );
  await flush();
  assertCount(calls.length, 1, "the replayed verdict must run compensation");
  assert(
    Object.keys(calls[0].row).join(",") === "id" && calls[0].row.id === "row-q",
    "after a reload the journal holds no values: compensation receives identity only",
  );
  assert(calls[0].context.cause === "denied", "the structured cause must reach the handler");
  fixture.ledger.dispose();
});

Deno.test("a synced obligation re-armed at boot receives the live store row", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["celebrate", unit("celebrate", calls)]]);
  const document: JournalDocument = emptyJournal();
  document.writes["w-live"] = {
    writeId: "w-live",
    verb: "addTask",
    table: "records",
    op: "insert",
    rowId: "row-l",
    batchId: "batch-l",
    rowHashes: { title: hashJournalValue(document.hashKey, "kept") },
    stage: "synced",
    cause: null,
    code: null,
    reason: null,
    createdAt: 1,
    expiresAt: null,
    effects: {
      celebrate: { status: "pending", attempts: 0, lastError: null, expiresAt: null },
    },
  };
  const storage = createMemoryJournalStorage(JSON.stringify(document));
  const fixture = harness({ storage, units });
  fixture.db.rows = [{ id: "row-l", title: "kept" }];
  await fixture.ledger.arm();
  await flush();
  assertCount(calls.length, 1, "the re-armed obligation must run");
  assert(
    (calls[0].row as { title?: string }).title === "kept",
    "a synced write's handler must receive the live row the store confirmed",
  );
  fixture.ledger.dispose();
});

Deno.test("an overdue intent surfaces in pending state and diagnostics without compensation", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["chargeCard", unit("chargeCard", calls)]]);
  const fixture = harness({ units, sweepIntervalMs: 5 });
  await fixture.ledger.arm();
  const handle = fixture.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "slow" } },
    { verb: "placeOrder", units: [units.get("chargeCard")!], expiresAfterMs: 50 },
  );
  await handle;
  assert(
    fixture.ledger.getPendingSnapshot().writes[0]?.expired === false,
    "an intent inside its lifespan is not overdue",
  );
  fixture.clock.value = 2000;
  await settleTimers(20);
  const snapshot = fixture.ledger.getPendingSnapshot();
  assert(snapshot.writes[0]?.expired === true, "the overdue intent must surface");
  assertCount(fixture.diagnostics.expiredPendingWrites, 1, "diagnostics must count it");
  assert(handle.stage === "saved", "no withdrawal exists, so the stage must not change");
  assertCount(calls.length, 0, "no compensation may fire for a write that can still sync");
  // The store later confirms the overdue write: it settles normally.
  fixture.db.settleGlobal();
  await flush();
  assert(String(handle.stage) === "synced", "a late confirmation still settles the write");
  fixture.ledger.dispose();
});

Deno.test("a closed delivery window retires the obligation: no handler, diagnosable, prunable", async () => {
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const units = new Map([["notifyOnce", unit("notifyOnce", calls, { expiresAfterMs: 30 })]]);
  const fixture = harness({ units });
  await fixture.ledger.arm();
  const handle = fixture.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "late" } },
    { units: [units.get("notifyOnce")!] },
  );
  await handle;
  // The device stays away past the delivery window; the write then syncs.
  fixture.clock.value = 5000;
  fixture.db.settleGlobal();
  await flush();
  assert(String(handle.stage) === "synced", "the write itself settled");
  assertCount(calls.length, 0, "the write happened, so no handler may fire past the window");
  assertCount(fixture.diagnostics.expiredObligations, 1, "the retirement must be diagnosable");
  await fixture.ledger.flush();
  assert(
    (fixture.storage.text() ?? "").includes(handle.writeId) === false,
    "a retired obligation makes the entry prunable",
  );
  fixture.ledger.dispose();
});

Deno.test("quarantine retires a permanently failing handler after its attempt bound", async () => {
  const storage = createMemoryJournalStorage();
  const calls: Array<
    { handler: "onSynced" | "onRejected"; row: { id: string }; context: EffectContext }
  > = [];
  const failing = unit("fragile", calls, { failAlways: true, maxAttempts: 2 });
  const first = harness({ storage, units: new Map([["fragile", failing]]) });
  await first.ledger.arm();
  const handle = first.ledger.perform<Row>(
    { kind: "insert", table: table as TableProxy<unknown, unknown>, values: { title: "boom" } },
    { units: [failing] },
  );
  await handle;
  first.db.settleGlobal();
  await flush();
  await first.ledger.flush();
  assertCount(first.diagnostics.effectHandlerFailures, 1, "the first failure is counted");
  assert((storage.text() ?? "").includes("fragile"), "the failed obligation re-arms at boot");
  first.ledger.dispose();

  const second = harness({ storage, units: new Map([["fragile", failing]]) });
  second.db.rows = [];
  await second.ledger.arm();
  await flush();
  assertCount(
    second.diagnostics.quarantinedObligations,
    1,
    "the attempt bound must quarantine the obligation",
  );
  await second.ledger.flush();
  assert(
    (second.storage.text() ?? "").includes(handle.writeId) === false,
    "a quarantined obligation makes the entry prunable",
  );
  assertCount(calls.length, 0, "a quarantined handler never reports success");
  second.ledger.dispose();
});
