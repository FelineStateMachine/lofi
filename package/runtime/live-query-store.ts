import type { Db, QueryBuilder } from "jazz-tools";
import type { RuntimeDiagnostics } from "./diagnostics.ts";
import { getRuntime, runtimeRecreatedEvent, updateRuntimeDiagnostics } from "./runtime.ts";
import { subscribeSharedKeyring } from "../schema/shared-keyring.ts";
import type { TableRow } from "./table-store.ts";

/** Honest read state for an arbitrary typed Jazz query. */
export type LiveQuerySnapshot<T extends TableRow> = {
  status: "loading" | "ready" | "error";
  rows: T[];
  error: string | null;
};

type Listener = () => void;
type QuerySubscriptionDb = Pick<Db, "subscribeAll">;

/** Runtime seams used by a live-query registry. Exported for deterministic framework tests. */
export type LiveQueryEnvironment = {
  getDb(): Promise<QuerySubscriptionDb>;
  subscribeRuntimeRecreation(listener: () => void): () => void;
  /** Fires when a shared field key is installed; stores resubscribe so rows
   * previously surfaced as key-pending re-materialize into plaintext. Key
   * installs are rare (boot, membership changes), so restarting every active
   * query is simpler than tracking which queries touch shared columns and
   * costs nothing in steady state. */
  subscribeSharedKeyring?(listener: () => void): () => void;
  updateDiagnostics(update: (diagnostics: RuntimeDiagnostics) => void): void;
};

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJson(nested)]),
  );
}

/** Returns the stable serialized plan used to share equivalent query stores. */
export function liveQueryKey<T extends TableRow>(query: QueryBuilder<T>): string {
  return JSON.stringify(canonicalJson(JSON.parse(query._build())));
}

/** A shared framework-neutral reactive store for one typed Jazz query. */
export class LiveQueryStore<T extends TableRow> {
  readonly #query: QueryBuilder<T>;
  readonly #environment: LiveQueryEnvironment;
  readonly #onIdle: () => void;
  readonly #listeners = new Set<Listener>();
  #snapshot: LiveQuerySnapshot<T> = { status: "loading", rows: [], error: null };
  #vendorUnsubscribe: (() => void) | null = null;
  #stopRuntimeRecreation: (() => void) | null = null;
  #stopKeyring: (() => void) | null = null;
  #generation = 0;
  #disposed = false;

  /** Creates one registry-owned store. Applications acquire stores through {@link acquireLiveQuery}. */
  constructor(
    query: QueryBuilder<T>,
    environment: LiveQueryEnvironment,
    onIdle: () => void,
  ) {
    this.#query = query;
    this.#environment = environment;
    this.#onIdle = onIdle;
  }

  /** Returns the current immutable query snapshot. */
  getSnapshot = (): LiveQuerySnapshot<T> => this.#snapshot;

  /** Subscribes one consumer and returns an idempotent cleanup function. */
  subscribe = (listener: Listener): () => void => {
    if (this.#disposed) throw new Error("live query store has been released");
    const subscriber = () => listener();
    this.#listeners.add(subscriber);
    this.#updateDiagnostics((diagnostics) => diagnostics.activeConsumers += 1);
    if (this.#listeners.size === 1) this.#start();
    listener();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (!this.#listeners.delete(subscriber)) return;
      this.#updateDiagnostics((diagnostics) => diagnostics.activeConsumers -= 1);
      if (this.#listeners.size === 0) {
        this.#stop();
        this.#onIdle();
      }
    };
  };

  /** Number of mounted framework-neutral consumers currently sharing this store. */
  get consumerCount(): number {
    return this.#listeners.size;
  }

  /** Releases every subscription owned by an evicted or hot-reloaded store. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const consumers = this.#listeners.size;
    this.#listeners.clear();
    if (consumers > 0) {
      this.#updateDiagnostics((diagnostics) => diagnostics.activeConsumers -= consumers);
    }
    this.#stop();
  }

  #start(): void {
    try {
      this.#stopRuntimeRecreation = this.#environment.subscribeRuntimeRecreation(() =>
        this.#restart()
      );
      this.#stopKeyring = this.#environment.subscribeSharedKeyring?.(() => this.#restart()) ??
        null;
      this.#connect();
    } catch (error) {
      this.#fail(error);
    }
  }

  #restart(): void {
    if (this.#disposed || this.#listeners.size === 0) return;
    this.#generation += 1;
    this.#closeVendorSubscription();
    this.#snapshot = { status: "loading", rows: [], error: null };
    this.#emit();
    this.#connect();
  }

  #connect(): void {
    const generation = ++this.#generation;
    void this.#environment.getDb().then((db) => {
      if (this.#disposed || generation !== this.#generation || this.#listeners.size === 0) return;
      try {
        const unsubscribe = db.subscribeAll(this.#query, (delta) => {
          if (this.#disposed || generation !== this.#generation) return;
          this.#snapshot = { status: "ready", rows: delta.all, error: null };
          this.#emit();
        });
        if (this.#disposed || generation !== this.#generation || this.#listeners.size === 0) {
          unsubscribe();
          return;
        }
        this.#vendorUnsubscribe = unsubscribe;
        this.#updateDiagnostics((diagnostics) => {
          diagnostics.activeVendorSubscriptions += 1;
          diagnostics.totalVendorSubscriptions += 1;
        });
      } catch (error) {
        this.#fail(error, generation);
      }
    }, (error) => this.#fail(error, generation));
  }

  #stop(): void {
    this.#generation += 1;
    this.#closeVendorSubscription();
    this.#stopRuntimeRecreation?.();
    this.#stopRuntimeRecreation = null;
    this.#stopKeyring?.();
    this.#stopKeyring = null;
  }

  #closeVendorSubscription(): void {
    if (!this.#vendorUnsubscribe) return;
    this.#vendorUnsubscribe();
    this.#vendorUnsubscribe = null;
    this.#updateDiagnostics((diagnostics) => {
      diagnostics.activeVendorSubscriptions -= 1;
      diagnostics.unsubscribeCalls += 1;
    });
  }

  #fail(error: unknown, generation = this.#generation): void {
    if (this.#disposed || generation !== this.#generation) return;
    this.#snapshot = {
      status: "error",
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
    this.#emit();
  }

  #updateDiagnostics(update: (diagnostics: RuntimeDiagnostics) => void): void {
    this.#environment.updateDiagnostics(update);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** A retained reference to a shared live-query store. Release it after its consumer unsubscribes. */
export type LiveQueryLease<T extends TableRow> = {
  store: LiveQueryStore<T>;
  release(): void;
};

type RegistryEntry = {
  store: LiveQueryStore<TableRow>;
  leases: number;
};

/** Registry that keys stores by schema identity and stable serialized query plan. */
export class LiveQueryRegistry {
  readonly #environment: LiveQueryEnvironment;
  readonly #schemas = new WeakMap<object, Map<string, RegistryEntry>>();
  readonly #stores = new Set<LiveQueryStore<TableRow>>();

  /** Creates an isolated registry over the supplied runtime environment. */
  constructor(environment: LiveQueryEnvironment) {
    this.#environment = environment;
  }

  /** Acquires a shared store and returns an idempotent ownership release. */
  acquire<T extends TableRow>(query: QueryBuilder<T>): LiveQueryLease<T> {
    const schema = query._schema as object;
    const key = liveQueryKey(query);
    let entries = this.#schemas.get(schema);
    if (!entries) {
      entries = new Map();
      this.#schemas.set(schema, entries);
    }
    let entry = entries.get(key);
    if (!entry) {
      const store = new LiveQueryStore(
        query,
        this.#environment,
        () => this.#evictIfUnused(entries!, key),
      );
      entry = { store: store as LiveQueryStore<TableRow>, leases: 0 };
      entries.set(key, entry);
      this.#stores.add(entry.store);
    }
    entry.leases += 1;
    let retained = true;
    return {
      store: entry.store as LiveQueryStore<T>,
      release: () => {
        if (!retained) return;
        retained = false;
        entry!.leases -= 1;
        this.#evictIfUnused(entries!, key);
      },
    };
  }

  /** Disposes every retained store, including active stores, during hot replacement. */
  dispose(): void {
    for (const store of this.#stores) store.dispose();
    this.#stores.clear();
  }

  #evictIfUnused(entries: Map<string, RegistryEntry>, key: string): void {
    const entry = entries.get(key);
    if (!entry || entry.leases > 0 || entry.store.consumerCount > 0) return;
    entries.delete(key);
    this.#stores.delete(entry.store);
    entry.store.dispose();
  }
}

const defaultRegistry = new LiveQueryRegistry({
  getDb: async () => (await getRuntime()).db,
  subscribeRuntimeRecreation(listener) {
    globalThis.addEventListener(runtimeRecreatedEvent, listener);
    return () => globalThis.removeEventListener(runtimeRecreatedEvent, listener);
  },
  subscribeSharedKeyring,
  updateDiagnostics,
});

function updateDiagnostics(update: (diagnostics: RuntimeDiagnostics) => void): void {
  updateRuntimeDiagnostics(update);
}

/** Acquires the package-wide shared store for an arbitrary typed query. */
export function acquireLiveQuery<T extends TableRow>(
  query: QueryBuilder<T>,
): LiveQueryLease<T> {
  return defaultRegistry.acquire(query);
}

import.meta.hot?.dispose(() => defaultRegistry.dispose());
