import type { Db, MutationErrorEvent, TableProxy } from "jazz-tools";
import { createDiagnostics } from "./diagnostics.ts";
import type { PwaState } from "./pwa.ts";
import {
  createSchemaCompatGate,
  SchemaCompatibilityError,
  type SchemaCompatState,
  type SchemaCompatUpdateSurface,
} from "./schema-compat.ts";
import { type TableMutationEnvironment, TableMutationRegistry } from "./table-mutations.ts";
import { assert } from "./test-assert.ts";

class FakeStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeUpdateSurface implements SchemaCompatUpdateSurface {
  checkForUpdateCalls = 0;
  #state: PwaState = { worker: "ready", install: "unsupported", update: "idle" };
  readonly #subscribers = new Set<(state: PwaState) => void>();

  getState(): PwaState {
    return this.#state;
  }
  subscribe(subscriber: (state: PwaState) => void): () => void {
    this.#subscribers.add(subscriber);
    subscriber(this.#state);
    return () => this.#subscribers.delete(subscriber);
  }
  checkForUpdate(): Promise<boolean> {
    this.checkForUpdateCalls += 1;
    return Promise.resolve(true);
  }
  setUpdate(update: PwaState["update"]): void {
    this.#state = { ...this.#state, update };
    for (const subscriber of this.#subscribers) subscriber(this.#state);
  }
}

const olderBundle = { v: 1, revision: "old", head: "v1:a", lineage: ["v1:a"] };
const newerBundle = { v: 1, revision: "new", head: "v1:b", lineage: ["v1:a", "v1:b"] };
const newerRecord = JSON.stringify({ v: 1, head: "v1:b", lineage: ["v1:a", "v1:b"] });
const storageKey = "lofi:schema-version:test";

function gateUnderTest(options: {
  manifest?: unknown;
  loadManifest?: () => Promise<unknown>;
  storage?: FakeStorage;
  surface?: FakeUpdateSurface;
  storageEvents?: EventTarget;
}) {
  const storage = options.storage ?? new FakeStorage();
  const surface = options.surface ?? new FakeUpdateSurface();
  const gate = createSchemaCompatGate({
    production: () => true,
    loadManifest: options.loadManifest ?? (() => Promise.resolve(options.manifest ?? null)),
    storage: () => storage,
    storageKey: () => storageKey,
    storageEvents: () => options.storageEvents,
    controller: () => surface,
  });
  return { gate, storage, surface };
}

function waitForState(
  gate: ReturnType<typeof createSchemaCompatGate>,
  predicate: (state: SchemaCompatState) => boolean,
): Promise<SchemaCompatState> {
  return new Promise((resolve) => {
    const unsubscribe = gate.subscribe((state) => {
      if (!predicate(state)) return;
      unsubscribe();
      resolve(state);
    });
  });
}

Deno.test("first boot is compatible and the runtime stamps the local version", async () => {
  const { gate, storage } = gateUnderTest({ manifest: olderBundle });
  const compatible = waitForState(gate, (state) => state.state === "compatible");
  gate.start();
  const state = await compatible;
  assert(
    state.state === "compatible" && state.classification === "first-boot",
    "an unstamped store was not classified first-boot",
  );
  await gate.assertWritable();
  gate.markRuntimeWritable();
  const record = JSON.parse(storage.getItem(storageKey) ?? "null");
  assert(record?.head === "v1:a", "a writable first boot did not stamp the local version");
});

Deno.test("code ahead of data migrates forward and advances the stamp", async () => {
  const storage = new FakeStorage();
  storage.setItem(storageKey, JSON.stringify({ v: 1, head: "v1:a", lineage: ["v1:a"] }));
  const { gate } = gateUnderTest({ manifest: newerBundle, storage });
  const compatible = waitForState(gate, (state) => state.state === "compatible");
  gate.start();
  const state = await compatible;
  assert(
    state.state === "compatible" && state.classification === "code-ahead",
    "a newer bundle over older data was not code-ahead",
  );
  await gate.assertWritable();
  gate.markRuntimeWritable();
  const record = JSON.parse(storage.getItem(storageKey) ?? "null");
  assert(record?.head === "v1:b", "the stamp did not advance to the new head");
  assert(record?.lineage?.includes("v1:a"), "the advanced stamp lost its lineage");
});

Deno.test("data ahead of code refuses writes, keeps the stamp, and prompts an update check", async () => {
  const storage = new FakeStorage();
  storage.setItem(storageKey, newerRecord);
  const { gate, surface } = gateUnderTest({ manifest: olderBundle, storage });
  const dataAhead = waitForState(gate, (state) => state.state === "data-ahead");
  gate.start();
  const state = await dataAhead;
  assert(state.state === "data-ahead" && state.reason === "schema", "wrong data-ahead reason");
  assert(state.message.includes("Update the app"), "the diagnostic does not name the remediation");
  let refused: unknown;
  try {
    await gate.assertWritable();
  } catch (error) {
    refused = error;
  }
  assert(refused instanceof SchemaCompatibilityError, "writes were not refused");
  gate.markRuntimeWritable();
  assert(storage.getItem(storageKey) === newerRecord, "a read-only boot rewrote the stamp");
  assert(surface.checkForUpdateCalls === 1, "the gate did not prompt an update check");
});

Deno.test("an unrelated schema history is treated as data-ahead, never writable", async () => {
  const storage = new FakeStorage();
  storage.setItem(storageKey, JSON.stringify({ v: 1, head: "v1:z", lineage: ["v1:z"] }));
  const { gate } = gateUnderTest({ manifest: olderBundle, storage });
  const dataAhead = waitForState(gate, (state) => state.state === "data-ahead");
  gate.start();
  await dataAhead;
  await gate.assertWritable().then(
    () => {
      throw new Error("an unrelated history allowed writes");
    },
    () => undefined,
  );
});

Deno.test("a data-ahead gate surfaces an in-flight update as updating", async () => {
  const storage = new FakeStorage();
  storage.setItem(storageKey, newerRecord);
  const { gate, surface } = gateUnderTest({ manifest: olderBundle, storage });
  gate.start();
  await waitForState(gate, (state) => state.state === "data-ahead");
  surface.setUpdate("installing");
  assert(gate.getState().state === "updating", "an installing update was not surfaced");
  surface.setUpdate("ready");
  assert(gate.getState().state === "data-ahead", "a ready update ended the refusal too early");
  surface.setUpdate("applying");
  assert(gate.getState().state === "updating", "an applying update was not surfaced");
  await gate.assertWritable().then(
    () => {
      throw new Error("writes resumed during the update window");
    },
    () => undefined,
  );
});

Deno.test("development mode and a missing manifest leave the gate inert", async () => {
  const inert = createSchemaCompatGate({ production: () => false });
  inert.start();
  assert(
    inert.getState().state === "unchecked" &&
      (inert.getState() as { reason?: string }).reason === "development",
    "development did not stay unchecked",
  );
  await inert.assertWritable();

  const { gate } = gateUnderTest({ manifest: null });
  const settled = waitForState(
    gate,
    (state) => state.state === "unchecked" && state.reason === "no-manifest",
  );
  gate.start();
  await settled;
  await gate.assertWritable();

  const failing = gateUnderTest({ loadManifest: () => Promise.reject(new Error("offline")) });
  const failedSettled = waitForState(
    failing.gate,
    (state) => state.state === "unchecked" && state.reason === "no-manifest",
  );
  failing.gate.start();
  await failedSettled;
  await failing.gate.assertWritable();
});

Deno.test("a write that races the verdict waits for it", async () => {
  const storage = new FakeStorage();
  storage.setItem(storageKey, newerRecord);
  let resolveManifest: (value: unknown) => void = () => undefined;
  const { gate } = gateUnderTest({
    storage,
    loadManifest: () => new Promise((resolve) => resolveManifest = resolve),
  });
  gate.start();
  const outcome: { value: "pending" | "allowed" | "refused" } = { value: "pending" };
  const write = gate.assertWritable().then(
    () => outcome.value = "allowed",
    () => outcome.value = "refused",
  );
  await Promise.resolve();
  const beforeVerdict = outcome.value;
  assert(beforeVerdict === "pending", "the write did not wait for the pending verdict");
  resolveManifest(olderBundle);
  await write;
  const afterVerdict = outcome.value;
  assert(afterVerdict === "refused", "the settled data-ahead verdict did not refuse the write");
});

Deno.test("another tab advancing the stamp flips this tab read-only in place", async () => {
  const storage = new FakeStorage();
  const storageEvents = new EventTarget();
  const { gate } = gateUnderTest({ manifest: olderBundle, storage, storageEvents });
  const compatible = waitForState(gate, (state) => state.state === "compatible");
  gate.start();
  await compatible;
  storage.setItem(storageKey, newerRecord);
  const dataAhead = waitForState(gate, (state) => state.state === "data-ahead");
  storageEvents.dispatchEvent(
    Object.assign(new Event("storage"), { key: storageKey }),
  );
  await dataAhead;
});

Deno.test("a stale tab after a worker swap is read-only with a reload prompt", async () => {
  const { gate } = gateUnderTest({ manifest: olderBundle });
  const compatible = waitForState(gate, (state) => state.state === "compatible");
  gate.start();
  await compatible;
  gate.markStaleTab();
  const state = gate.getState();
  assert(
    state.state === "data-ahead" && state.reason === "stale-tab" &&
      state.message.includes("Reload"),
    "the stale tab was not flipped to a reload prompt",
  );
  await gate.assertWritable().then(
    () => {
      throw new Error("a stale tab allowed writes");
    },
    () => undefined,
  );
});

// ---------------------------------------------------------------------------
// Integration: an old shell next to newer data. The local record was stamped
// under a migrated schema; a bundle pinned to the older manifest boots, and
// the mutation surface — wired exactly like the production registry — refuses
// the write with the gate's diagnostic.
// ---------------------------------------------------------------------------

type Row = { id: string; title: string };
type Init = Omit<Row, "id">;
const table = { _table: "records", _schema: {} } as TableProxy<Row, Init>;

class RefusingDb {
  operations = 0;
  value(): Db {
    return this as unknown as Db;
  }
  onMutationError(_listener: (event: MutationErrorEvent) => void): () => void {
    return () => undefined;
  }
  insert(_table: TableProxy<Row, Init>, values: Init) {
    this.operations += 1;
    return { wait: () => Promise.resolve({ id: "row-1", ...values }) };
  }
}

Deno.test("an old shell over newer data refuses table writes with the gate diagnostic", async () => {
  const storage = new FakeStorage();
  storage.setItem(storageKey, newerRecord);
  const { gate } = gateUnderTest({ manifest: olderBundle, storage });
  gate.start();
  await waitForState(gate, (state) => state.state === "data-ahead");

  const db = new RefusingDb();
  const diagnostics = createDiagnostics();
  const environment: TableMutationEnvironment = {
    getDb: () => Promise.resolve(db.value()),
    syncConfigured: () => false,
    subscribeRuntimeRecreation: () => () => undefined,
    updateDiagnostics: (update) => update(diagnostics),
    async guardWrite() {
      await gate.assertWritable();
    },
  };
  const store = new TableMutationRegistry(environment).acquire(table).store;
  let refused: unknown;
  try {
    await store.insert({ title: "blocked" });
  } catch (error) {
    refused = error;
  }
  assert(refused instanceof SchemaCompatibilityError, "the mutation store allowed the write");
  assert(db.operations === 0, "the refused write still reached the database");
  assert(diagnostics.mutationErrors === 1, "the refusal was not counted in diagnostics");
  assert(
    store.getSnapshot().error?.includes("newer version") === true,
    "the store snapshot does not carry the user-facing diagnostic",
  );
});
