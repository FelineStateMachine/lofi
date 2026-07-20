import type { InsertOf, RowOf, WhereOf } from "jazz-tools";

/**
 * How a peer's view is read for convergence comparison. Headless peers expose
 * their tables; browser peers expose the app-supplied value-free snapshot.
 * Registered by the adapters; not part of the public surface.
 */
export type ConvergeSource =
  | {
    kind: "tables";
    tableKeys: readonly string[];
    counterColumns(table: string): ReadonlySet<string>;
    setColumns(table: string): ReadonlySet<string>;
    readTable(key: string, tier: "local" | "global"): Promise<readonly Record<string, unknown>[]>;
  }
  | {
    kind: "snapshot";
    snapshot(): Promise<unknown>;
  };

const convergeSources = new WeakMap<object, ConvergeSource>();

/** Attach a peer's converge source. Called by the adapters when a peer boots. */
export function registerConvergeSource(peer: object, source: ConvergeSource): void {
  convergeSources.set(peer, source);
}

/** Look up a peer's converge source, or `undefined` for foreign objects. */
export function convergeSourceOf(peer: object): ConvergeSource | undefined {
  return convergeSources.get(peer);
}

/**
 * The table names of an app: every key whose value is a table handle. The
 * app object's non-table members (`union`, `wasmSchema`) are excluded by
 * shape, not by name, so future non-table members stay excluded too.
 */
export type ScenarioTableKey<A> =
  & {
    [K in keyof A]: A[K] extends { readonly _table: string } ? K : never;
  }[keyof A]
  & string;

/** Options for reads through a {@link ScenarioTable}. */
export interface ScenarioReadOptions {
  /**
   * Durability tier to read at. `"local"` (the default) returns the peer's
   * current local view and works offline; `"global"` waits until the read
   * reflects globally durable data and requires the peer to be online.
   */
  tier?: "local" | "global";
}

/**
 * One table of a headless peer's typed facade: the app's insert/update/remove
 * writes, applied to the peer's local view immediately (online or offline),
 * plus local-view reads. Writes issued here are tracked by the owning peer so
 * {@link ScenarioPeerControls.settle} can wait for their global durability.
 */
export interface ScenarioTable<Row, Init, Where> {
  /** Insert a row and resolve with it as applied to the local view. */
  insert(values: Init): Promise<Row>;
  /** Update a row by id in the local view. */
  update(id: string, patch: Partial<Init>): Promise<void>;
  /** Delete a row by id from the local view. */
  remove(id: string): Promise<void>;
  /** Read every row this peer can currently see. */
  all(where?: Where, options?: ScenarioReadOptions): Promise<readonly Row[]>;
  /** Read one row by id, or `undefined` when this peer cannot see it. */
  get(id: string, options?: ScenarioReadOptions): Promise<Row | undefined>;
}

/** The app's tables as scenario facades, keyed by the app's own table names. */
export type ScenarioDb<A> = {
  readonly [K in ScenarioTableKey<A>]: ScenarioTable<RowOf<A[K]>, InsertOf<A[K]>, WhereOf<A[K]>>;
};

/** Options for {@link ScenarioPeerControls.settle}. */
export interface ScenarioSettleOptions {
  /** Defensive deadline for the settle wait. Defaults to 20 seconds. */
  timeoutMs?: number;
}

/**
 * The controls every scenario peer implements, headless or browser: a stable
 * name, an offline window toggle, and a durability barrier for issued writes.
 */
export interface ScenarioPeerControls {
  /** The peer's name in the scenario, e.g. `"alice"`. */
  readonly name: string;
  /** Whether the peer is currently inside an offline window. */
  readonly isOffline: boolean;
  /** Open an offline window: the peer keeps working locally without syncing. */
  offline(): Promise<void>;
  /** Close the offline window and resume syncing. */
  online(): Promise<void>;
  /**
   * Resolve once every write issued through this peer has reached global
   * durability. The peer must be online; offline peers cannot settle and the
   * wait fails at its deadline with a reminder to call
   * {@link ScenarioPeerControls.online} first.
   */
  settle(options?: ScenarioSettleOptions): Promise<void>;
}

/**
 * A headless scenario peer: a real synced client with the scenario controls
 * plus the app's typed table API. Writes issued through {@link db} apply to
 * this peer's local view immediately — pair them with
 * {@link ScenarioPeerControls.settle} or a convergence assertion when the
 * scenario needs them visible elsewhere.
 */
export interface ScenarioPeer<A> extends ScenarioPeerControls {
  /** The app's tables, scoped to this peer's replica. */
  readonly db: ScenarioDb<A>;
  /**
   * Restart the peer: tear the client down and boot a fresh one with the same
   * identity. Headless peers run on a memory driver, so unsynced local state
   * is lost — what survives a restart is what had already synced.
   */
  restart(): Promise<void>;
}
