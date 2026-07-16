import type { Db, MutationErrorEvent, QueryBuilder, TableProxy } from "jazz-tools";
import type { RuntimeDiagnostics } from "./diagnostics.ts";

/** The minimum shape every persisted row exposes to the framework. */
export type TableRow = { id: string };

/**
 * A declared schema table (`schema.<name>`). It is both an insert/update/delete
 * target and a query source, so the store accepts the intersection Jazz expects.
 * `T` is the row type and `Init` the insert type (row minus server-owned fields).
 */
export type TableHandle<T extends TableRow, Init> = TableProxy<T, Init> & QueryBuilder<T>;

export type TableSnapshot<T extends TableRow> = {
  status: "loading" | "ready" | "error";
  rows: T[];
  durability: "none" | "local" | "global" | "failed";
  error: string | null;
};

type Listener = () => void;
type MutationHandle = {
  wait(options: { tier: "local" | "global" }): Promise<unknown>;
};

export type TableStoreOptions = {
  /** Whether managed sync is configured; gates global-durability waits. */
  syncConfigured?: boolean;
  /** Called whenever a diagnostics counter changes. */
  onDiagnosticsChange?: () => void;
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
  readonly #syncConfigured: boolean;
  readonly #diagnosticsChanged: () => void;
  readonly #listeners = new Set<Listener>();
  readonly #stopMutationErrors: () => void;
  #vendorUnsubscribe: (() => void) | null = null;
  #writeGeneration = 0;
  #snapshot: TableSnapshot<T> = {
    status: "loading",
    rows: [],
    durability: "none",
    error: null,
  };

  constructor(
    db: Db,
    table: TableHandle<T, Init>,
    diagnostics: RuntimeDiagnostics,
    options: TableStoreOptions = {},
  ) {
    this.#db = db;
    this.#table = table;
    this.#diagnostics = diagnostics;
    this.#syncConfigured = options.syncConfigured ?? false;
    this.#diagnosticsChanged = options.onDiagnosticsChange ?? (() => undefined);
    // Asynchronous write rejections that are not tied to an awaited mutation
    // still have to reach diagnostics and the UI, so the store owns this listener.
    this.#stopMutationErrors = db.onMutationError((event) => this.reportMutationError(event));
    this.#diagnostics.activeMutationListeners += 1;
    this.#diagnostics.totalMutationListeners += 1;
    this.#diagnosticsChanged();
  }

  getSnapshot = (): TableSnapshot<T> => this.#snapshot;

  subscribe = (listener: Listener): () => void => {
    this.#listeners.add(listener);
    this.#diagnostics.activeConsumers = this.#listeners.size;
    this.#diagnosticsChanged();
    if (this.#listeners.size === 1) this.#openVendorSubscription();
    this.#emit();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
      this.#diagnostics.activeConsumers = this.#listeners.size;
      this.#diagnosticsChanged();
      if (this.#listeners.size === 0) this.#closeVendorSubscription();
      else this.#emit();
    };
  };

  async insert(values: Init): Promise<void> {
    await this.#settle(this.#db.insert(this.#table, values));
  }

  async update(id: string, patch: Partial<Init>): Promise<void> {
    await this.#settle(this.#db.update(this.#table, id, patch));
  }

  async delete(id: string): Promise<void> {
    await this.#settle(this.#db.delete(this.#table, id));
  }

  reportMutationError(event: MutationErrorEvent): void {
    this.#diagnostics.mutationErrors += 1;
    this.#diagnosticsChanged();
    this.#fail(new Error(`${event.code}: ${event.reason}`));
  }

  close(): void {
    this.#listeners.clear();
    this.#diagnostics.activeConsumers = 0;
    this.#closeVendorSubscription();
    this.#stopMutationErrors();
    this.#diagnostics.activeMutationListeners -= 1;
    this.#diagnosticsChanged();
  }

  async #settle(mutation: MutationHandle): Promise<void> {
    const generation = ++this.#writeGeneration;
    let localPending = true;
    this.#diagnostics.pendingLocalWrites += 1;
    this.#diagnosticsChanged();
    this.#set({ status: "ready", durability: "none", error: null });
    try {
      await mutation.wait({ tier: "local" });
      localPending = false;
      this.#diagnostics.pendingLocalWrites -= 1;
      this.#diagnostics.localWaitCalls += 1;
      this.#diagnosticsChanged();
      if (generation === this.#writeGeneration) {
        this.#set({ durability: "local", error: null });
      }
      if (this.#syncConfigured) {
        this.#diagnostics.pendingGlobalWrites += 1;
        this.#diagnosticsChanged();
        void mutation.wait({ tier: "global" }).then(
          () => {
            if (generation === this.#writeGeneration) {
              this.#set({ durability: "global", error: null });
            }
          },
          (error) => {
            this.#diagnostics.mutationErrors += 1;
            this.#diagnosticsChanged();
            this.#fail(error);
          },
        ).finally(() => {
          this.#diagnostics.pendingGlobalWrites -= 1;
          this.#diagnosticsChanged();
        });
      }
    } catch (error) {
      if (localPending) this.#diagnostics.pendingLocalWrites -= 1;
      this.#diagnostics.mutationErrors += 1;
      this.#diagnosticsChanged();
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
