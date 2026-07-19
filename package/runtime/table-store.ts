import type { Db, MutationErrorEvent, QueryBuilder, TableProxy } from "jazz-tools";
// Package-owned reactive table store.
import type { RuntimeDiagnostics } from "./diagnostics.ts";
import { settleDurableWrite } from "./durability.ts";

/** The minimum shape every persisted row exposes to the framework. */
export type TableRow = { id: string };

/**
 * The row type of one declared schema table — `RowOf<typeof app.schema.tasks>`.
 * Lets author code derive row types from its schema without importing the
 * vendor module, keeping UI islands on public package seams.
 */
export type RowOf<Table> = Table extends { readonly _rowType: infer Row } ? Row : never;

/**
 * A declared schema table (`schema.<name>`). It is both an insert/update/delete
 * target and a query source, so the store accepts the intersection Jazz expects.
 * `T` is the row type and `Init` the insert type (row minus server-owned fields).
 */
export type TableHandle<T extends TableRow, Init> = TableProxy<T, Init> & QueryBuilder<T>;

/** Reactive table state including rows and the last observed durability tier. */
export type TableSnapshot<T extends TableRow> = {
  status: "loading" | "ready" | "error";
  rows: T[];
  durability: "none" | "local" | "global" | "failed";
  error: string | null;
};

type Listener = () => void;
type MutationHandle = {
  /** The vendor batch id, used to attribute asynchronous rejections. */
  batchId?: unknown;
  wait(options: { tier: "local" | "global" }): Promise<unknown>;
};

// Own-batch attribution keeps a bounded window of recent writes; late
// rejections older than this are diagnostics-only.
const MAX_TRACKED_BATCHES = 128;

/** Runtime options controlling durability waits and diagnostics notifications. */
export type TableStoreOptions = {
  /**
   * Whether managed sync is configured; gates global-durability waits. Read
   * live on every write so stores follow sync elections and stops without
   * being recreated.
   */
  syncConfigured?: () => boolean;
  /** Called whenever a diagnostics counter changes. */
  onDiagnosticsChange?: () => void;
  /**
   * Runs before each mutation reaches the database: rejects to refuse the
   * write (the schema-compatibility gate), and may resolve with a release
   * function invoked once the write settles. Absent means unguarded writes.
   */
  guardWrite?: () => Promise<(() => void) | void>;
};

/**
 * A generic, reactive store over a single declared table. It has no knowledge of
 * the application schema beyond {@link TableRow}: callers bind it to one of their
 * own `schema.<name>` tables and read/write typed rows through it.
 */
export class TableStore<T extends TableRow, Init> {
  readonly #db: Db;
  readonly #table: TableHandle<T, Init>;
  readonly #diagnostics: RuntimeDiagnostics;
  readonly #syncConfigured: () => boolean;
  readonly #diagnosticsChanged: () => void;
  readonly #guardWrite?: () => Promise<(() => void) | void>;
  readonly #listeners = new Set<Listener>();
  readonly #stopMutationErrors: () => void;
  readonly #ownBatches = new Set<unknown>();
  #batchTracking = false;
  #vendorUnsubscribe: (() => void) | null = null;
  #writeGeneration = 0;
  #snapshot: TableSnapshot<T> = {
    status: "loading",
    rows: [],
    durability: "none",
    error: null,
  };

  /** Creates a store over one declared Jazz table and shared runtime diagnostics. */
  constructor(
    db: Db,
    table: TableHandle<T, Init>,
    diagnostics: RuntimeDiagnostics,
    options: TableStoreOptions = {},
  ) {
    this.#db = db;
    this.#table = table;
    this.#diagnostics = diagnostics;
    this.#syncConfigured = options.syncConfigured ?? (() => false);
    this.#diagnosticsChanged = options.onDiagnosticsChange ?? (() => undefined);
    this.#guardWrite = options.guardWrite;
    // Asynchronous write rejections that are not tied to an awaited mutation
    // still have to reach diagnostics and the UI, so the store owns this
    // listener. The vendor event is database-wide, so it is filtered to this
    // store's own batches — one table's rejection must not mark every store
    // failed or multiply diagnostics counts.
    this.#stopMutationErrors = db.onMutationError((event) => {
      if (this.#ownsBatch(event)) this.reportMutationError(event);
    });
    this.#diagnostics.activeMutationListeners += 1;
    this.#diagnostics.totalMutationListeners += 1;
    this.#diagnosticsChanged();
  }

  /** Returns the current immutable snapshot. */
  getSnapshot = (): TableSnapshot<T> => this.#snapshot;

  /** Subscribes to snapshot changes and opens the vendor subscription on first use. */
  subscribe = (listener: Listener): () => void => {
    const subscriber = () => listener();
    this.#listeners.add(subscriber);
    this.#diagnostics.activeConsumers += 1;
    this.#diagnosticsChanged();
    if (this.#listeners.size === 1) this.#openVendorSubscription();
    this.#emit();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      // After close() the listener set is already empty; a late unsubscribe
      // must not decrement consumers a second time.
      if (!this.#listeners.delete(subscriber)) return;
      this.#diagnostics.activeConsumers -= 1;
      this.#diagnosticsChanged();
      if (this.#listeners.size === 0) this.#closeVendorSubscription();
      else this.#emit();
    };
  };

  /** Inserts a row and waits for local durability before resolving. */
  async insert(values: Init): Promise<void> {
    await this.#perform(() => this.#db.insert(this.#table, values));
  }

  /** Updates a row and waits for local durability before resolving. */
  async update(id: string, patch: Partial<Init>): Promise<void> {
    await this.#perform(() => this.#db.update(this.#table, id, patch));
  }

  /** Deletes a row and waits for local durability before resolving. */
  async delete(id: string): Promise<void> {
    await this.#perform(() => this.#db.delete(this.#table, id));
  }

  // The guard runs before the mutation reaches the vendor: a refusal (the
  // schema-compatibility gate) surfaces like any write failure, and the
  // release ends this write's hold on the cross-tab write lock once the
  // write settles — the quiescence bar an upgrade swap waits on.
  async #perform(create: () => MutationHandle): Promise<void> {
    let releaseGuard: (() => void) | undefined;
    try {
      releaseGuard = (await this.#guardWrite?.()) ?? undefined;
    } catch (error) {
      this.#fail(error);
      throw error;
    }
    try {
      await this.#settle(create());
    } finally {
      releaseGuard?.();
    }
  }

  /** Projects an asynchronous Jazz mutation rejection into diagnostics and store state. */
  reportMutationError(event: MutationErrorEvent): void {
    this.#diagnostics.mutationErrors += 1;
    this.#diagnosticsChanged();
    this.#fail(new Error(`${event.code}: ${event.reason}`));
  }

  /** Releases vendor subscriptions and mutation listeners owned by this store. */
  close(): void {
    this.#diagnostics.activeConsumers -= this.#listeners.size;
    this.#listeners.clear();
    this.#closeVendorSubscription();
    this.#stopMutationErrors();
    this.#diagnostics.activeMutationListeners -= 1;
    this.#diagnosticsChanged();
  }

  #ownsBatch(event: MutationErrorEvent): boolean {
    const batchId = event.batch?.batchId;
    // Attribution is only possible when the vendor exposes batch ids on both
    // sides; without them, surface every event rather than silence real errors.
    if (batchId === undefined || !this.#batchTracking) return true;
    return this.#ownBatches.has(batchId);
  }

  #trackBatch(mutation: MutationHandle): void {
    if (mutation.batchId === undefined) return;
    this.#batchTracking = true;
    this.#ownBatches.add(mutation.batchId);
    if (this.#ownBatches.size > MAX_TRACKED_BATCHES) {
      this.#ownBatches.delete(this.#ownBatches.values().next().value);
    }
  }

  #updateDiagnostics = (update: (diagnostics: RuntimeDiagnostics) => void): void => {
    update(this.#diagnostics);
    this.#diagnosticsChanged();
  };

  async #settle(mutation: MutationHandle): Promise<void> {
    const generation = ++this.#writeGeneration;
    this.#trackBatch(mutation);
    // A store that has not received its first query result stays loading —
    // a mutation must not present an empty table as ready.
    this.#set({
      status: this.#snapshot.status === "loading" ? "loading" : "ready",
      durability: "none",
      error: null,
    });
    try {
      // Generation guards keep a superseded write's late outcome — success or
      // rejection — diagnosable without overwriting the newer write's state.
      await settleDurableWrite(
        mutation,
        this.#updateDiagnostics,
        this.#syncConfigured() ? "background" : "none",
        {
          onLocal: () => {
            if (generation === this.#writeGeneration) {
              this.#set({ durability: "local", error: null });
            }
          },
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
      this.#fail(error);
      throw error;
    }
  }

  #openVendorSubscription(): void {
    if (this.#vendorUnsubscribe) return;
    try {
      this.#vendorUnsubscribe = this.#db.subscribeAll(this.#table, (delta) => {
        this.#snapshot = {
          ...this.#snapshot,
          status: "ready",
          rows: delta.all,
          error: null,
        };
        this.#emit();
      });
      this.#diagnostics.activeVendorSubscriptions += 1;
      this.#diagnostics.totalVendorSubscriptions += 1;
      this.#diagnosticsChanged();
    } catch (error) {
      this.#fail(error);
    }
  }

  #closeVendorSubscription(): void {
    if (!this.#vendorUnsubscribe) return;
    this.#vendorUnsubscribe();
    this.#diagnostics.unsubscribeCalls += 1;
    this.#vendorUnsubscribe = null;
    this.#diagnostics.activeVendorSubscriptions -= 1;
    this.#diagnosticsChanged();
  }

  #set(change: Partial<TableSnapshot<T>>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    if (change.durability) {
      this.#diagnostics.lastWriteDurability = change.durability;
      this.#diagnosticsChanged();
    }
    this.#emit();
  }

  #fail(error: unknown): void {
    this.#snapshot = {
      ...this.#snapshot,
      status: "error",
      durability: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    this.#diagnostics.lastWriteDurability = "failed";
    this.#diagnosticsChanged();
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export function createTableStore<T extends TableRow, Init>(
  db: Db,
  table: TableHandle<T, Init>,
  diagnostics: RuntimeDiagnostics,
  options: TableStoreOptions = {},
): TableStore<T, Init> {
  return new TableStore<T, Init>(db, table, diagnostics, options);
}
