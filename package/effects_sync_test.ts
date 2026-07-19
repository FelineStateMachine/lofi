// Effect-system integration against a real local Jazz server: two-client
// stage progression with single-device effect delivery, boot reconciliation
// over a copied journal, and the adjudicated stale-policy rejection path.
// Runs in its own task (test:effects) because the server needs FFI.
import { createDb, type Db, schema as s } from "jazz-tools";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";
import type { EffectContext, EffectUnit } from "./schema/effects.ts";
import { createDiagnostics } from "./runtime/diagnostics.ts";
import { assert, assertCount } from "./runtime/test-assert.ts";
import { createMemoryJournalStorage } from "./runtime/write-journal.ts";
import { WriteLedger, type WriteLedgerEnvironment } from "./runtime/write-ledger.ts";

const app = s.defineApp({
  notes: s.table({ text: s.string() }),
});
const openPermissions = s.definePermissions(app, ({ policy }) => {
  policy.notes.allowInsert.always();
  policy.notes.allowRead.always();
  policy.notes.allowUpdate.always();
  policy.notes.allowDelete.always();
});
// No write rule: a store deployed with this denies every insert.
const closedPermissions = s.definePermissions(app, ({ policy }) => {
  policy.notes.allowRead.always();
});

function secret(fill: number): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(fill)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function within<T>(operation: Promise<T>, label: string, milliseconds = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type EffectCall = { handler: "onSynced" | "onRejected"; context: EffectContext };

function recordingUnit(name: string, calls: EffectCall[]): EffectUnit<{ id: string }> {
  return {
    effectName: name,
    handlers: {
      onSynced: (_row, context) => void calls.push({ handler: "onSynced", context }),
      onRejected: (_row, context) => void calls.push({ handler: "onRejected", context }),
    },
  };
}

function ledgerOver(db: Db, options: {
  storage?: ReturnType<typeof createMemoryJournalStorage>;
  units?: Map<string, EffectUnit<{ id: string }>>;
} = {}) {
  const diagnostics = createDiagnostics();
  const storage = options.storage ?? createMemoryJournalStorage();
  const units = options.units ?? new Map<string, EffectUnit<{ id: string }>>();
  const environment: WriteLedgerEnvironment = {
    getDb: () => Promise.resolve(db),
    syncConfigured: () => true,
    storage,
    resolveTable: (name) =>
      name === "notes"
        ? app.notes as unknown as { where(input: Record<string, unknown>): unknown }
        : null,
    resolveEffectUnit: (name) => units.get(name) ?? null,
    subscribeRuntimeRecreation: () => () => undefined,
    updateDiagnostics: (update) => update(diagnostics),
    now: Date.now,
    retryDelayMs: () => 250,
    probeTimeoutMs: 8000,
  };
  return { ledger: new WriteLedger(environment), storage, diagnostics };
}

type Harness = {
  server: Awaited<ReturnType<typeof startLocalJazzServer>>;
  client(fill: number): Promise<Db>;
  stop(): Promise<void>;
};

async function bootHarness(): Promise<Harness> {
  const server = await startLocalJazzServer({ allowLocalFirstAuth: true });
  await deploy({
    appId: server.appId,
    serverUrl: server.url,
    adminSecret: server.adminSecret,
    schema: app,
    permissions: openPermissions,
  });
  const clients: Db[] = [];
  return {
    server,
    async client(fill: number) {
      const db = await createDb({
        appId: server.appId,
        serverUrl: server.url,
        secret: secret(fill),
        userBranch: "main",
        driver: { type: "memory" },
      });
      clients.push(db);
      return db;
    },
    async stop() {
      await Promise.allSettled(
        clients.map((db, index) => within(db.logout(), `client ${index} cleanup`, 3_000)),
      );
      await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
    },
  };
}

function waitFor(predicate: () => boolean, label: string, milliseconds = 20_000): Promise<void> {
  return within(
    (async () => {
      while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 100));
    })(),
    label,
    milliseconds,
  );
}

Deno.test("two clients: stages progress and onSynced fires only on the originating device", async () => {
  const harness = await bootHarness();
  try {
    const aliceDb = await harness.client(1);
    const bobDb = await harness.client(2);
    const aliceCalls: EffectCall[] = [];
    const bobCalls: EffectCall[] = [];
    const aliceUnit = recordingUnit("notifyTeam", aliceCalls);
    const alice = ledgerOver(aliceDb, { units: new Map([["notifyTeam", aliceUnit]]) });
    const bob = ledgerOver(bobDb, {
      units: new Map([["notifyTeam", recordingUnit("notifyTeam", bobCalls)]]),
    });
    await alice.ledger.arm();
    await bob.ledger.arm();

    const handle = alice.ledger.perform<{ id: string; text: string }>(
      { kind: "insert", table: app.notes as never, values: { text: "from alice" } },
      { verb: "addNote", units: [aliceUnit] },
    );
    const stages: string[] = [handle.stage];
    handle.subscribe(() => {
      if (stages.at(-1) !== handle.stage) stages.push(handle.stage);
    });
    const row = await within(Promise.resolve(handle), "saved settlement");
    assert(row.text === "from alice", "await must resolve the created row at saved");
    await within(handle.synced, "synced settlement");
    assert(
      stages.join(",").endsWith("saved,synced") || stages.join(",") === "saved,synced" ||
        stages.join(",") === "saving,saved,synced",
      `stages must progress monotonically (saw ${stages.join(",")})`,
    );

    const bobView = await within(
      bobDb.all(app.notes.where({ id: row.id }), { tier: "global" }),
      "bob read",
    );
    assertCount(bobView.length, 1, "the second client must sync the row");
    await waitFor(() => aliceCalls.length > 0, "originating-device effect delivery");
    assertCount(aliceCalls.length, 1, "onSynced must fire exactly once on the writer");
    assert(aliceCalls[0].handler === "onSynced", "confirmation runs the action handler");
    // Give any wrongly-armed effect a moment to surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assertCount(bobCalls.length, 0, "effects run on the originating device only");
    assertCount(alice.ledger.getPendingSnapshot().count, 0, "nothing may stay pending");
    alice.ledger.dispose();
    bob.ledger.dispose();
  } finally {
    await harness.stop();
  }
});

Deno.test("boot reconciliation: a journaled write settles and its effect fires after sync resolves", async () => {
  const harness = await bootHarness();
  try {
    const writerDb = await harness.client(1);
    const writer = ledgerOver(writerDb);
    await writer.ledger.arm();
    const handle = writer.ledger.perform<{ id: string; text: string }>(
      { kind: "insert", table: app.notes as never, values: { text: "journaled" } },
      { verb: "addNote", units: [recordingUnit("celebrate", [])] },
    );
    await within(Promise.resolve(handle), "saved settlement");
    await writer.ledger.flush();
    // Freeze the journal at the saved stage: this is the on-disk state a
    // crashed device would boot from.
    const frozen = writer.storage.text();
    assert(frozen !== null && frozen.includes(handle.writeId), "the write must be journaled");
    await within(handle.synced, "writer synced settlement");
    writer.ledger.dispose();

    // A fresh runtime for the same account boots from the frozen journal.
    const rebootDb = await harness.client(1);
    const calls: EffectCall[] = [];
    const reboot = ledgerOver(rebootDb, {
      storage: createMemoryJournalStorage(frozen),
      units: new Map([["celebrate", recordingUnit("celebrate", calls)]]),
    });
    await reboot.ledger.arm();
    await waitFor(() => calls.length > 0, "re-armed effect delivery");
    assertCount(calls.length, 1, "the re-armed effect must fire exactly once");
    assert(calls[0].handler === "onSynced", "the confirmed write runs the action handler");
    assert(
      calls[0].context.journalId === `${handle.writeId}:celebrate`,
      "the idempotency key must survive the reboot",
    );
    assertCount(reboot.ledger.getPendingSnapshot().count, 0, "the entry must settle");
    reboot.ledger.dispose();
  } finally {
    await harness.stop();
  }
});

Deno.test("stale-policy rejection: rejected stage, one compensation, engine rolls the row back", async () => {
  const harness = await bootHarness();
  try {
    const aliceDb = await harness.client(1);
    // Seed while the open policy is in force so the client holds it locally.
    const seeded = await within(
      aliceDb.insert(app.notes, { text: "seed" }).wait({ tier: "global" }),
      "seed insert",
    );
    const calls: EffectCall[] = [];
    const chargeCard = recordingUnit("chargeCard", calls);
    const alice = ledgerOver(aliceDb, { units: new Map([["chargeCard", chargeCard]]) });
    await alice.ledger.arm();

    await within(aliceDb.disconnect(), "disconnect", 5_000);
    // The store's permissions tighten while the device is offline.
    await deploy({
      appId: harness.server.appId,
      serverUrl: harness.server.url,
      adminSecret: harness.server.adminSecret,
      schema: app,
      permissions: closedPermissions,
    });

    // Accepted locally under the stale policy: no throw, a live handle.
    const handle = alice.ledger.perform<{ id: string; text: string }>(
      { kind: "insert", table: app.notes as never, values: { text: "stale write" } },
      { verb: "addNote", units: [chargeCard] },
    );
    await within(aliceDb.reconnect(), "reconnect", 10_000);
    await waitFor(() => handle.stage === "rejected", "adjudicated verdict");
    assert(handle.reason?.code === "permission_denied", "the verdict code must surface");

    await waitFor(() => calls.length > 0, "compensation delivery");
    assertCount(calls.length, 1, "onRejected must fire exactly once");
    assert(calls[0].handler === "onRejected", "the denied write runs compensation");

    // The engine itself rolls the rejected write back out of local reads: the
    // optimistic row must not linger as apparent success.
    const rows = await within(
      aliceDb.all(app.notes.where({}), { tier: "local" }),
      "post-rejection read",
    );
    assert(
      rows.every((row) => row.text !== "stale write"),
      "the rejected optimistic row must leave local query results",
    );
    assert(rows.some((row) => row.id === seeded.id), "unrelated rows must survive");
    assertCount(alice.ledger.getPendingSnapshot().count, 0, "the rejected write is not pending");
    alice.ledger.dispose();
  } finally {
    await harness.stop();
  }
});
