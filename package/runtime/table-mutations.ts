import type { Db, MutationErrorEvent, TableProxy } from "jazz-tools";
import { syncing } from "./config.ts";
import type { RuntimeDiagnostics } from "./diagnostics.ts";
import { settleDurableWrite } from "./durability.ts";
import { getRuntime, runtimeRecreatedEvent, updateRuntimeDiagnostics } from "./runtime.ts";
import { assertSchemaWritable } from "./schema-compat.ts";
import type { TableRow } from "./table-store.ts";
import { acquireUpgradeWriteLock } from "./upgrade-coordination.ts";

/** Observable state shared by every mutation consumer for one table. */
export type TableMutationSnapshot = {
  pending: number;
  durability: "none" | "local" | "global" | "failed";
  error: string | null;
};

type Listener = () => void;
type MutationHandle<T> = {
  /** The vendor batch id, used to attribute asynchronous rejections. */
  batchId?: unknown;
  wait(options: { tier: "local" | "global" }): Promise<T>;
};

// Own-batch attribution keeps a bounded window of recent writes; late
// rejections older than this are diagnostics-only.
const MAX_TRACKED_BATCHES = 128;

/** Runtime seams used by table-mutation tests and the package-wide registry. */
export type TableMutationEnvironment = {
  getDb(): Promise<Db>;
  syncConfigured(): boolean;
  subscribeRuntimeRecreation(listener: () => void): () => void;
  updateDiagnostics(update: (diagnostics: RuntimeDiagnostics) => void): void;
  /**
   * Runs before each mutation reaches the database: rejects to refuse the
   * write (the schema-compatibility gate), and may resolve with a release
   * function that is invoked once the write settles locally (the cross-tab
   * write lock). Absent means writes are never guarded.
   */
  guardWrite?(): Promise<(() => void) | void>;
};

/** Framework-neutral typed mutations and observable durability for one table. */
export class TableMutationStore<T extends TableRow, Init> {
  readonly #table: TableProxy<T, Init>;
  readonly #environment: TableMutationEnvironment;
  readonly #onIdle: () => void;
  readonly #listeners = new Set<Listener>();
  readonly #ownBatches = new Set<unknown>();
  #batchTracking = false;
  #snapshot: TableMutationSnapshot = { pending: 0, durability: "none", error: null };
  #stopMutationErrors: (() => void) | null = null;
  #stopRuntimeRecreation: (() => void) | null = null;
  #generation = 0;
  #writeGeneration = 0;
  #disposed = false;

  /** Creates one registry-owned mutation store. */
  constructor(
    table: TableProxy<T, Init>,
    environment: TableMutationEnvironment,
    onIdle: () => void,
  ) {
    this.#table = table;
    this.#environment = environment;
    this.#onIdle = onIdle;
  }

  /** Returns current pending, durability, and rejection state. */
  getSnapshot = (): TableMutationSnapshot => this.#snapshot;

  /** Retains the table-scoped error listener for one consumer. */
  subscribe = (listener: Listener): () => void => {
    if (this.#disposed) throw new Error("table mutation store has been released");
    const subscriber = () => listener();
    this.#listeners.add(subscriber);
    if (this.#listeners.size === 1) this.#start();
    listener();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(subscriber);
      if (this.#listeners.size === 0) {
        this.#stop();
        this.#onIdle();
      }
    };
  };

  /** Number of mounted consumers sharing this table-scoped mutation state. */
  get consumerCount(): number {
    return this.#listeners.size;
  }

  /** Inserts and returns the typed created row after local durability. */
  async insert(values: Init): Promise<T> {
    return await this.#perform((db) => db.insert(this.#table, values));
  }

  /** Updates a row and resolves after local durability. */
  async update(id: string, patch: Partial<Init>): Promise<void> {
    await this.#perform((db) => db.update(this.#table, id, patch));
  }

  /** Deletes a row and resolves after local durability. */
  async remove(id: string): Promise<void> {
    await this.#perform((db) => db.delete(this.#table, id));
  }

  /** Releases listeners owned by an evicted or hot-reloaded store. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#stop();
  }

  async #perform<Result>(create: (db: Db) => MutationHandle<Result>): Promise<Result> {
    if (this.#disposed) throw new Error("table mutation store has been released");
    // The guard runs before the mutation reaches the vendor: a refusal (the
    // schema-compatibility gate) surfaces like any mutation failure, and the
    // returned release ends this write's hold on the cross-tab write lock
    // once the write settles to the local tier — the quiescence bar an
    // upgrade swap waits on.
    let releaseGuard: (() => void) | undefined;
    try {
      releaseGuard = (await this.#environment.guardWrite?.()) ?? undefined;
    } catch (error) {
      this.#updateDiagnostics((diagnostics) => diagnostics.mutationErrors += 1);
      this.#fail(error);
      throw error;
    }
    try {
      const db = await this.#environment.getDb();
      let mutation: MutationHandle<Result>;
      try {
        mutation = create(db);
      } catch (error) {
        this.#updateDiagnostics((diagnostics) => diagnostics.mutationErrors += 1);
        this.#fail(error);
        throw error;
      }
      return await this.#settle(mutation);
    } finally {
      releaseGuard?.();
    }
  }

  #ownsBatch(event: MutationErrorEvent): boolean {
    const batchId = event.batch?.batchId;
    // Attribution is only possible when the vendor exposes batch ids on both
    // sides; without them, surface every event rather than silence real errors.
    if (batchId === undefined || !this.#batchTracking) return true;
    return this.#ownBatches.has(batchId);
  }

  #trackBatch<Result>(mutation: MutationHandle<Result>): void {
    if (mutation.batchId === undefined) return;
    this.#batchTracking = true;
    this.#ownBatches.add(mutation.batchId);
    if (this.#ownBatches.size > MAX_TRACKED_BATCHES) {
      this.#ownBatches.delete(this.#ownBatches.values().next().value);
    }
  }

  async #settle<Result>(mutation: MutationHandle<Result>): Promise<Result> {
    const generation = ++this.#writeGeneration;
    this.#trackBatch(mutation);
    this.#set({ pending: this.#snapshot.pending + 1, durability: "none", error: null });
    try {
      // Generation guards keep a superseded write's late outcome — success or
      // rejection — diagnosable without overwriting the newer write's state.
      return await settleDurableWrite(
        mutation,
        (update) => this.#updateDiagnostics(update),
        this.#environment.syncConfigured() ? "background" : "none",
        {
          onLocal: () =>
            this.#set({
              pending: Math.max(0, this.#snapshot.pending - 1),
              ...(generation === this.#writeGeneration ? { durability: "local" as const } : {}),
            }),
          onGlobal: () => {
            if (generation === this.#writeGeneration) {
              this.#set({ durability: "global", error: null });
            }
          },
          onGlobalError: (error) => {
            if (generation === this.#writeGeneration) this.#fail(error);
          },
        },
      );
    } catch (error) {
      this.#set({ pending: Math.max(0, this.#snapshot.pending - 1) });
      this.#fail(error);
      throw error;
    }
  }

  #start(): void {
    this.#stopRuntimeRecreation = this.#environment.subscribeRuntimeRecreation(() =>
      this.#attach()
    );
    this.#attach();
  }

  #attach(): void {
    const generation = ++this.#generation;
    this.#detachMutationErrors();
    void this.#environment.getDb().then((db) => {
      if (this.#disposed || generation !== this.#generation || this.#listeners.size === 0) return;
      let stop: () => void;
      try {
        stop = db.onMutationError((event) => this.#reportMutationError(event, generation));
      } catch (error) {
        this.#fail(error, generation);
        return;
      }
      if (this.#disposed || generation !== this.#generation || this.#listeners.size === 0) {
        stop();
        return;
      }
      this.#stopMutationErrors = stop;
      this.#updateDiagnostics((diagnostics) => {
        diagnostics.activeMutationListeners += 1;
        diagnostics.totalMutationListeners += 1;
      });
    }, (error) => this.#fail(error, generation));
  }

  #reportMutationError(event: MutationErrorEvent, generation: number): void {
    if (generation !== this.#generation) return;
    // The vendor event is database-wide; only this store's own batches may
    // mark it failed or count against its diagnostics.
    if (!this.#ownsBatch(event)) return;
    this.#updateDiagnostics((diagnostics) => diagnostics.mutationErrors += 1);
    this.#fail(new Error(`${event.code}: ${event.reason}`));
  }

  #stop(): void {
    this.#generation += 1;
    this.#detachMutationErrors();
    this.#stopRuntimeRecreation?.();
    this.#stopRuntimeRecreation = null;
  }

  #detachMutationErrors(): void {
    if (!this.#stopMutationErrors) return;
    this.#stopMutationErrors();
    this.#stopMutationErrors = null;
    this.#updateDiagnostics((diagnostics) => diagnostics.activeMutationListeners -= 1);
  }

  #fail(error: unknown, generation = this.#generation): void {
    if (this.#disposed || generation !== this.#generation) return;
    this.#set({
      durability: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  #set(change: Partial<TableMutationSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    if (change.durability) {
      this.#updateDiagnostics((diagnostics) =>
        diagnostics.lastWriteDurability = change.durability!
      );
    }
    for (const listener of this.#listeners) listener();
  }

  #updateDiagnostics(update: (diagnostics: RuntimeDiagnostics) => void): void {
    this.#environment.updateDiagnostics(update);
  }
}

/** Retained ownership of one shared table-mutation store. */
export type TableMutationLease<T extends TableRow, Init> = {
  store: TableMutationStore<T, Init>;
  release(): void;
};

type Entry = { store: TableMutationStore<TableRow, unknown>; leases: number };

/** Shares mutation state and one vendor error listener per schema table. */
export class TableMutationRegistry {
  readonly #environment: TableMutationEnvironment;
  readonly #schemas = new WeakMap<object, Map<string, Entry>>();
  readonly #stores = new Set<TableMutationStore<TableRow, unknown>>();

  /** Creates an isolated registry over one runtime environment. */
  constructor(environment: TableMutationEnvironment) {
    this.#environment = environment;
  }

  /** Acquires the shared mutation surface for a typed table. */
  acquire<T extends TableRow, Init>(table: TableProxy<T, Init>): TableMutationLease<T, Init> {
    const schema = table._schema as object;
    let entries = this.#schemas.get(schema);
    if (!entries) {
      entries = new Map();
      this.#schemas.set(schema, entries);
    }
    let entry = entries.get(table._table);
    if (!entry) {
      const store = new TableMutationStore(
        table,
        this.#environment,
        () => this.#evictIfUnused(entries!, table._table),
      );
      entry = { store: store as TableMutationStore<TableRow, unknown>, leases: 0 };
      entries.set(table._table, entry);
      this.#stores.add(entry.store);
    }
    entry.leases += 1;
    let retained = true;
    return {
      store: entry.store as TableMutationStore<T, Init>,
      release: () => {
        if (!retained) return;
        retained = false;
        entry!.leases -= 1;
        this.#evictIfUnused(entries!, table._table);
      },
    };
  }

  /** Disposes all active stores during hot replacement. */
  dispose(): void {
    for (const store of this.#stores) store.dispose();
    this.#stores.clear();
  }

  #evictIfUnused(entries: Map<string, Entry>, key: string): void {
    const entry = entries.get(key);
    if (!entry || entry.leases > 0 || entry.store.consumerCount > 0) return;
    entries.delete(key);
    this.#stores.delete(entry.store);
    entry.store.dispose();
  }
}

const defaultRegistry = new TableMutationRegistry({
  getDb: async () => (await getRuntime()).db,
  syncConfigured: syncing,
  subscribeRuntimeRecreation(listener) {
    globalThis.addEventListener(runtimeRecreatedEvent, listener);
    return () => globalThis.removeEventListener(runtimeRecreatedEvent, listener);
  },
  updateDiagnostics: updateRuntimeDiagnostics,
  async guardWrite() {
    await assertSchemaWritable();
    return await acquireUpgradeWriteLock();
  },
});

/** Acquires the package-wide typed mutation surface for one table. */
export function acquireTableMutations<T extends TableRow, Init>(
  table: TableProxy<T, Init>,
): TableMutationLease<T, Init> {
  return defaultRegistry.acquire(table);
}

import.meta.hot?.dispose(() => defaultRegistry.dispose());
