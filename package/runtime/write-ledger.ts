/**
 * Package-owned write ledger: the runtime half of the effect system.
 *
 * Every write performed here gets a {@link WriteHandle}, a journal entry, and
 * — when its verb declares them — effect obligations. The ledger settles each
 * write against the store, fires effect handlers on the originating device
 * when the write's fate resolves, and reconstructs pending state from the
 * journal at boot: entries whose rows the store already confirms settle as
 * synced, adjudicated verdicts settle as rejected, and everything else stays
 * pending under periodic probes until the store answers.
 *
 * Verdict handling follows the sync-node contract: a synchronous local
 * refusal throws from the call site and never journals; an adjudicated
 * rejection settles the write only when
 * {@link classifyMutationError} calls its code permanent. The engine rolls a
 * rejected write back out of local query results itself, so compensation
 * handlers repair what the user was told, not the row.
 *
 * @module
 */

import type { Db, MutationErrorEvent, TableProxy } from "jazz-tools";
import {
  type EffectContext,
  type EffectRow,
  type EffectUnit,
  type MutationDescriptor,
  resolveEffectUnit,
  setMutationRuntime,
} from "../schema/effects.ts";
import { appId, syncing } from "./config.ts";
import { recordEffectLogEntry, type RuntimeDiagnostics } from "./diagnostics.ts";
import { settleDurableWrite } from "./durability.ts";
import { classifyMutationError } from "./mutation-taxonomy.ts";
import {
  findRuntimeTable,
  getRuntime,
  runtimeRecreatedEvent,
  updateRuntimeDiagnostics,
} from "./runtime.ts";
import { assertSchemaWritable } from "./schema-compat.ts";
import { acquireUpgradeWriteLock } from "./upgrade-coordination.ts";
import { WriteHandle } from "./write-handle.ts";
import {
  createDefaultJournalStorage,
  journalIdFor,
  type JournalStorage,
  type JournalWriteRecord,
  WriteJournal,
} from "./write-journal.ts";

/** One write not yet settled, as shown by pending-writes surfaces. */
export type PendingWriteSummary = {
  /** The stable journal id of the write. */
  writeId: string;
  /** The declaring verb's name, or `null` for writes without a verb. */
  verb: string | null;
  /** The written table's name. */
  table: string;
  /** The written row's id. */
  rowId: string;
  /** Which operation the write performed. */
  op: "insert" | "update" | "remove";
  /** Epoch milliseconds when the write was journaled. */
  createdAt: number;
};

/** The reload-safe pending set powering "N changes waiting to sync". */
export type PendingWritesSnapshot = {
  /** How many journaled writes have not settled. */
  count: number;
  /** The pending writes, oldest first. */
  writes: readonly PendingWriteSummary[];
};

/** Per-row sync state for badges: settled, still waiting, or denied. */
export type RowSyncStatus = "synced" | "waiting" | "rejected";

/** A write the ledger can perform. */
export type LedgerWriteRequest =
  | { kind: "insert"; table: TableProxy<unknown, unknown>; values: unknown }
  | {
    kind: "update";
    table: TableProxy<unknown, unknown>;
    id: string;
    patch: Record<string, unknown>;
  }
  | { kind: "remove"; table: TableProxy<unknown, unknown>; id: string };

/** Verb metadata carried by a ledger write. */
export type LedgerWriteOptions = {
  /** The declaring verb's name, or `null` for bare table writes. */
  verb?: string | null;
  /** The effect units journaled with this write. */
  units?: readonly EffectUnit<{ id: string }>[];
};

type VendorWrite = {
  batchId?: unknown;
  value?: unknown;
  wait(options: { tier: "local" | "global" }): Promise<unknown>;
};

type LedgerDb = Pick<Db, "onMutationError"> & {
  insert(table: never, values: never): VendorWrite;
  update(table: never, id: string, patch: never): VendorWrite;
  delete(table: never, id: string): VendorWrite;
  all(query: never, options?: { tier: "local" | "global" }): Promise<unknown[]>;
};

type ProbeTable = { where(input: Record<string, unknown>): unknown };

/** Runtime seams used by the ledger; tests inject deterministic values. */
export type WriteLedgerEnvironment = {
  /** Opens (or returns) the vendor database. */
  getDb(): Promise<Db>;
  /** Whether managed sync is configured; read live on every write. */
  syncConfigured(): boolean;
  /** Where the journal persists. */
  storage: JournalStorage;
  /** Resolves a declared table by name for boot-reconciliation probes. */
  resolveTable(name: string): ProbeTable | null;
  /** Resolves a registered effect unit by its durable name. */
  resolveEffectUnit(name: string): EffectUnit<{ id: string }> | null;
  /** Subscribes to runtime replacement, so settlement re-arms on a new client. */
  subscribeRuntimeRecreation(listener: () => void): () => void;
  /** Applies one diagnostics update. */
  updateDiagnostics(update: (diagnostics: RuntimeDiagnostics) => void): void;
  /** Current epoch milliseconds. */
  now(): number;
  /** Delay before settlement retry `attempt`; injectable for deterministic tests. */
  retryDelayMs?: (attempt: number) => number;
  /** How long a global-tier probe may run before it is retried later. */
  probeTimeoutMs?: number;
  /**
   * Runs before each write reaches the database: rejects to refuse the write
   * (the schema-compatibility gate — the refusal surfaces through the verb
   * call with no journal entry, stage, or effect), and may resolve with a
   * release function invoked once the write settles locally (the cross-tab
   * write lock). Absent means writes are never guarded.
   */
  guardWrite?(): Promise<(() => void) | void>;
};

const defaultRetryDelay = (attempt: number): number => Math.min(4000 * (attempt + 1), 30_000);

function rejectionShape(error: unknown): { code: string; reason: string } | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { name?: unknown; code?: unknown; reason?: unknown };
  if (value.name !== "PersistedWriteRejectedError" || typeof value.code !== "string") return null;
  return { code: value.code, reason: typeof value.reason === "string" ? value.reason : "" };
}

function normalized(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function fieldsMatch(journaled: Record<string, unknown>, row: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(journaled)) {
    if (key === "id") continue;
    if (JSON.stringify(normalized(value)) !== JSON.stringify(normalized(row[key]))) return false;
  }
  return true;
}

/**
 * The per-app write ledger. One instance owns the journal, the pending-writes
 * observable, boot reconciliation, and effect delivery. Application code
 * reaches it through verbs and hooks; tests construct isolated instances over
 * an injected {@link WriteLedgerEnvironment}.
 */
export class WriteLedger {
  readonly #environment: WriteLedgerEnvironment;
  readonly #journal: WriteJournal;
  readonly #listeners = new Set<() => void>();
  readonly #running = new Set<string>();
  readonly #probing = new Set<string>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #sessionFates = new Map<string, { stage: "synced" | "rejected"; at: number }>();
  #handles = new Map<string, WriteHandle<unknown>>();
  #db: LedgerDb | null = null;
  #stopMutationErrors: (() => void) | null = null;
  #stopRecreation: (() => void) | null = null;
  #armed: Promise<void> | null = null;
  #pendingSnapshot: PendingWritesSnapshot = { count: 0, writes: [] };
  #disposed = false;

  /** Creates a ledger over one environment; call {@link arm} before relying on boot state. */
  constructor(environment: WriteLedgerEnvironment) {
    this.#environment = environment;
    this.#journal = new WriteJournal(environment.storage);
  }

  /**
   * Loads the journal and reconciles it against the store: confirmed writes
   * settle as synced, replayed verdicts settle as rejected, unsettled writes
   * stay pending under probes, and settled writes with outstanding effect
   * obligations re-run their handlers. Idempotent.
   */
  arm(): Promise<void> {
    this.#armed ??= this.#reconcile();
    return this.#armed;
  }

  /** Level-triggered pending-writes state; identity changes only on change. */
  getPendingSnapshot = (): PendingWritesSnapshot => this.#pendingSnapshot;

  /** Subscribes to ledger changes; the listener runs immediately and on every change. */
  subscribe = (listener: () => void): () => void => {
    this.#listeners.add(listener);
    listener();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  };

  /** The sync status of one row, derived from journal entries and session fates. */
  rowStatus(rowId: string): RowSyncStatus {
    for (const entry of Object.values(this.#journal.document.writes)) {
      if (entry.rowId === rowId && entry.stage === "saved") return "waiting";
    }
    for (const entry of Object.values(this.#journal.document.writes)) {
      if (entry.rowId === rowId && entry.stage === "rejected") return "rejected";
    }
    const fate = this.#sessionFates.get(rowId);
    if (fate?.stage === "rejected") return "rejected";
    return "synced";
  }

  /**
   * Performs one write. A refusal — the write guard's or the runtime's own
   * current-policy check — leaves through the verb call as ordinary author
   * error handling and never creates a journal entry, a stage, or an effect:
   * it throws synchronously when the unguarded database is already open, and
   * fails the returned handle otherwise. The handle resolves at `saved` and
   * settles through `synced` or `rejected`.
   */
  perform<T>(request: LedgerWriteRequest, options: LedgerWriteOptions = {}): WriteHandle<T> {
    if (this.#disposed) throw new Error("write ledger has been disposed");
    const handle = new WriteHandle<T>(crypto.randomUUID());
    const db = this.#db;
    const guard = this.#environment.guardWrite;
    if (db && !guard) {
      this.#execute(db, request, options, handle as WriteHandle<unknown>);
      return handle;
    }
    void (async () => {
      let release: (() => void) | undefined;
      try {
        release = (await guard?.()) ?? undefined;
      } catch (error) {
        // A guard refusal is not a verdict: nothing is journaled and no
        // effect fires; the failure surfaces like any refused mutation.
        this.#environment.updateDiagnostics((diagnostics) => diagnostics.mutationErrors += 1);
        handle.fail(error);
        return;
      }
      try {
        const openDb = await this.#withDb();
        this.#execute(openDb, request, options, handle as WriteHandle<unknown>);
      } catch (error) {
        handle.fail(error);
      } finally {
        if (release) {
          // The lock covers the local-durability window: it releases when
          // the write settles locally or fails, matching the quiescence bar
          // an upgrade swap waits on.
          const done = release;
          handle.saved.then(() => done(), () => done());
        }
      }
    })();
    return handle;
  }

  /** Performs one declared verb call; the verb dispatcher's entry point. */
  performVerb(descriptor: MutationDescriptor, args: readonly unknown[]): WriteHandle<unknown> {
    const table = descriptor.op.table as TableProxy<unknown, unknown>;
    const options: LedgerWriteOptions = { verb: descriptor.verbName, units: descriptor.units };
    if (descriptor.op.kind === "insert") {
      return this.perform({ kind: "insert", table, values: args[0] }, options);
    }
    if (descriptor.op.kind === "update") {
      return this.perform({
        kind: "update",
        table,
        id: args[0] as string,
        patch: args[1] as Record<string, unknown>,
      }, options);
    }
    return this.perform({ kind: "remove", table, id: args[0] as string }, options);
  }

  /** Re-attempts outstanding obligations of one effect name after late registration. */
  retryObligationsFor(effectName: string): void {
    for (const entry of Object.values(this.#journal.document.writes)) {
      if (entry.stage === "saved") continue;
      const state = entry.effects[effectName];
      if (state && state.status !== "done") void this.#runObligation(entry, effectName);
    }
  }

  /** Resolves once scheduled journal persistence has settled; test seam. */
  flush(): Promise<void> {
    return this.#journal.flush();
  }

  /** Releases listeners and cancels every scheduled probe and retry. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#listeners.clear();
    this.#stopMutationErrors?.();
    this.#stopMutationErrors = null;
    this.#stopRecreation?.();
    this.#stopRecreation = null;
  }

  async #withDb(): Promise<LedgerDb> {
    if (this.#db) return this.#db;
    const db = await this.#environment.getDb() as unknown as LedgerDb;
    if (this.#db !== db) {
      this.#db = db;
      this.#attachMutationErrors(db);
    }
    this.#stopRecreation ??= this.#environment.subscribeRuntimeRecreation(() => {
      this.#db = null;
      this.#stopMutationErrors?.();
      this.#stopMutationErrors = null;
      void this.#withDb().then(() => this.#startProbes(), () => undefined);
    });
    return db;
  }

  #attachMutationErrors(db: LedgerDb): void {
    // The fallback event fires once per runtime lifetime; the journal records
    // the verdict idempotently on arrival and never waits for a re-fire.
    this.#stopMutationErrors = db.onMutationError((event: MutationErrorEvent) => {
      const batchId = event.batch?.batchId;
      if (batchId === undefined) return;
      const entry = Object.values(this.#journal.document.writes)
        .find((candidate) => candidate.batchId === String(batchId));
      if (entry) this.#applyVerdict(entry, event.code ?? null, event.reason ?? "");
    });
  }

  async #reconcile(): Promise<void> {
    await this.#journal.load();
    this.#afterChange();
    await this.#withDb();
    if (this.#disposed) return;
    for (const entry of Object.values(this.#journal.document.writes)) {
      if (entry.stage === "saved") continue;
      // A settled write with outstanding obligations means a crash landed
      // between handler start and journal completion: at-least-once delivery
      // re-runs the handlers now.
      this.#fireUnits(entry);
    }
    this.#startProbes();
  }

  #startProbes(): void {
    for (const entry of Object.values(this.#journal.document.writes)) {
      if (entry.stage === "saved") this.#probe(entry.writeId, 0);
    }
  }

  #probe(writeId: string, attempt: number): void {
    if (this.#disposed || this.#probing.has(writeId)) return;
    const entry = this.#journal.document.writes[writeId];
    if (!entry || entry.stage !== "saved") return;
    const db = this.#db;
    const table = this.#environment.resolveTable(entry.table);
    if (!db || !table) {
      this.#scheduleProbe(writeId, attempt + 1);
      return;
    }
    this.#probing.add(writeId);
    const timeoutMs = this.#environment.probeTimeoutMs ?? 8000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      this.#timers.add(timer);
    });
    const read = db.all(table.where({ id: entry.rowId }) as never, { tier: "global" })
      .then((rows) => rows as Array<Record<string, unknown>>, () => null);
    void Promise.race([read, expired]).then((rows) => {
      if (timer !== undefined) {
        clearTimeout(timer);
        this.#timers.delete(timer);
      }
      this.#probing.delete(writeId);
      if (this.#disposed) return;
      const current = this.#journal.document.writes[writeId];
      if (!current || current.stage !== "saved") return;
      if (rows === null) {
        this.#scheduleProbe(writeId, attempt + 1);
        return;
      }
      const row = rows.find((candidate) => candidate.id === current.rowId);
      const confirmed = current.op === "remove"
        ? row === undefined
        : row !== undefined && fieldsMatch(current.row, row);
      if (confirmed) this.#settleSynced(current);
      else this.#scheduleProbe(writeId, attempt + 1);
    });
  }

  #scheduleProbe(writeId: string, attempt: number): void {
    if (this.#disposed) return;
    const delay = (this.#environment.retryDelayMs ?? defaultRetryDelay)(attempt);
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#probe(writeId, attempt);
    }, delay);
    this.#timers.add(timer);
  }

  #execute(
    db: LedgerDb,
    request: LedgerWriteRequest,
    options: LedgerWriteOptions,
    handle: WriteHandle<unknown>,
  ): void {
    let vendor: VendorWrite;
    let rowId: string;
    let rowSnapshot: Record<string, unknown>;
    try {
      if (request.kind === "insert") {
        vendor = db.insert(request.table as never, request.values as never);
        const value = vendor.value as { id: string } | undefined;
        rowId = value?.id ?? "";
        rowSnapshot = { ...(normalized(value) as Record<string, unknown> ?? {}) };
      } else if (request.kind === "update") {
        vendor = db.update(request.table as never, request.id, request.patch as never);
        rowId = request.id;
        rowSnapshot = { id: request.id, ...(normalized(request.patch) as Record<string, unknown>) };
      } else {
        vendor = db.delete(request.table as never, request.id);
        rowId = request.id;
        rowSnapshot = { id: request.id };
      }
    } catch (error) {
      // A current-policy refusal: no batch, no journal entry, no stage. The
      // error leaves through the verb call as ordinary author error handling.
      this.#environment.updateDiagnostics((diagnostics) => diagnostics.mutationErrors += 1);
      throw error;
    }
    const entry: JournalWriteRecord = {
      writeId: handle.writeId,
      verb: options.verb ?? null,
      table: (request.table as { _table?: string })._table ?? "",
      op: request.kind,
      rowId,
      batchId: vendor.batchId === undefined ? null : String(vendor.batchId),
      row: rowSnapshot,
      stage: "saved",
      code: null,
      reason: null,
      createdAt: this.#environment.now(),
      effects: Object.fromEntries(
        (options.units ?? []).map((unit) => [
          unit.effectName,
          { status: "pending" as const, attempts: 0, lastError: null },
        ]),
      ),
    };
    this.#journal.update((document) => {
      document.writes[entry.writeId] = entry;
    });
    this.#handles.set(entry.writeId, handle);
    handle.setBatchId(entry.batchId);
    // Pre-stage the insert's row value so a fast global confirmation can
    // never resolve the stage promises before the value is known.
    if (request.kind === "insert") handle.advance("saving", vendor.value);
    this.#afterChange();
    void this.#settle(vendor, entry, handle);
  }

  async #settle(
    vendor: VendorWrite,
    entry: JournalWriteRecord,
    handle: WriteHandle<unknown>,
  ): Promise<void> {
    const syncConfigured = this.#environment.syncConfigured();
    let value: unknown;
    try {
      value = await settleDurableWrite(
        vendor as { wait(options: { tier: "local" | "global" }): Promise<unknown> },
        (update) => this.#environment.updateDiagnostics(update),
        syncConfigured ? "background" : "none",
        {
          onGlobal: () => this.#settleSynced(entry),
          onGlobalError: (error) => this.#handleSettlementError(vendor, entry, error, 0),
        },
      );
    } catch (error) {
      const rejection = rejectionShape(error);
      if (rejection) {
        // Some drivers surface the adjudicated verdict through the local-tier
        // wait; it is still a verdict, not a local durability failure.
        this.#applyVerdict(entry, rejection.code, rejection.reason);
        return;
      }
      // Local durability failed: the write never became durable, so the
      // journal must not present it as pending sync.
      this.#journal.update((document) => {
        delete document.writes[entry.writeId];
      });
      this.#handles.delete(entry.writeId);
      handle.fail(error);
      this.#afterChange();
      return;
    }
    handle.advance("saved", value);
    // Without a sync location there is no store to adjudicate: local
    // durability is settlement, and effects run now.
    if (!syncConfigured) this.#settleSynced(entry);
  }

  #handleSettlementError(
    vendor: VendorWrite,
    entry: JournalWriteRecord,
    error: unknown,
    attempt: number,
  ): void {
    const rejection = rejectionShape(error);
    if (rejection) {
      this.#applyVerdict(entry, rejection.code, rejection.reason);
      if (this.#journal.document.writes[entry.writeId]?.stage === "saved") {
        // A non-permanent verdict keeps the write pending; re-derive later.
        this.#scheduleWaitRetry(vendor, entry, attempt + 1);
      }
      return;
    }
    // A transport failure is not a verdict; the write stays pending.
    this.#scheduleWaitRetry(vendor, entry, attempt + 1);
  }

  #scheduleWaitRetry(vendor: VendorWrite, entry: JournalWriteRecord, attempt: number): void {
    if (this.#disposed) return;
    const delay = (this.#environment.retryDelayMs ?? defaultRetryDelay)(attempt);
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      const current = this.#journal.document.writes[entry.writeId];
      if (!current || current.stage !== "saved") return;
      vendor.wait({ tier: "global" }).then(
        () => this.#settleSynced(current),
        (error) => this.#handleSettlementError(vendor, current, error, attempt),
      );
    }, delay);
    this.#timers.add(timer);
  }

  #settleSynced(entry: JournalWriteRecord): void {
    const current = this.#journal.document.writes[entry.writeId];
    if (!current || current.stage !== "saved") return;
    this.#journal.update(() => {
      current.stage = "synced";
    });
    const handle = this.#handles.get(current.writeId);
    handle?.advance("synced");
    this.#fireUnits(current);
    this.#afterChange();
  }

  #applyVerdict(entry: JournalWriteRecord, code: string | null, reason: string): void {
    const current = this.#journal.document.writes[entry.writeId];
    if (!current || current.stage !== "saved") return;
    if (classifyMutationError(code) !== "permanent") return;
    this.#journal.update(() => {
      current.stage = "rejected";
      current.code = code;
      current.reason = reason;
    });
    const handle = this.#handles.get(current.writeId);
    handle?.reject({ code, reason });
    this.#fireUnits(current);
    this.#afterChange();
  }

  #fireUnits(entry: JournalWriteRecord): void {
    // Units are independent: each runs in its own task with its own journal
    // state, so one handler's failure never blocks another unit, and there
    // are no ordering guarantees between units of one write.
    for (const name of Object.keys(entry.effects)) {
      void this.#runObligation(entry, name);
    }
  }

  async #runObligation(entry: JournalWriteRecord, effectName: string): Promise<void> {
    const journalId = journalIdFor(entry.writeId, effectName);
    const state = entry.effects[effectName];
    if (!state || state.status === "done" || this.#running.has(journalId)) return;
    const unit = this.#environment.resolveEffectUnit(effectName);
    // An unregistered unit stays pending: its declaring module may not have
    // loaded yet, and registration re-attempts outstanding obligations.
    if (!unit) return;
    const fate = entry.stage === "synced" ? "synced" as const : "rejected" as const;
    const handler = fate === "synced" ? unit.handlers.onSynced : unit.handlers.onRejected;
    if (!handler) {
      this.#journal.update(() => {
        state.status = "done";
      });
      this.#afterChange();
      return;
    }
    this.#running.add(journalId);
    // Attempts are journaled before the handler starts: a crash mid-handler
    // re-runs it at the next boot — the documented at-least-once contract.
    this.#journal.update(() => {
      state.attempts += 1;
      state.status = "pending";
    });
    const context: EffectContext = {
      journalId,
      writeId: entry.writeId,
      verb: entry.verb,
      table: entry.table,
      rowId: entry.rowId,
      fate,
      code: entry.code,
      reason: entry.reason,
    };
    try {
      await handler(entry.row as EffectRow<{ id: string }>, context);
      this.#journal.update(() => {
        state.status = "done";
        state.lastError = null;
      });
    } catch (error) {
      this.#journal.update(() => {
        state.status = "failed";
        state.lastError = error instanceof Error ? error.message : String(error);
      });
      this.#environment.updateDiagnostics((diagnostics) => diagnostics.effectHandlerFailures += 1);
    } finally {
      this.#running.delete(journalId);
      this.#afterChange();
    }
  }

  #afterChange(): void {
    const document = this.#journal.document;
    for (const entry of Object.values(document.writes)) {
      if (entry.stage === "saved") continue;
      const fate = this.#sessionFates.get(entry.rowId);
      if (!fate || fate.at <= entry.createdAt) {
        this.#sessionFates.set(entry.rowId, { stage: entry.stage, at: entry.createdAt });
      }
      const settled = Object.values(entry.effects)
        .every((state) => state.status === "done");
      if (settled) {
        // Fully settled entries leave the journal; failed obligations keep
        // theirs so the next boot can re-arm the handler.
        this.#journal.update(() => {
          delete document.writes[entry.writeId];
        });
        this.#handles.delete(entry.writeId);
      }
    }
    const pending = Object.values(document.writes)
      .filter((entry) => entry.stage === "saved")
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((entry): PendingWriteSummary => ({
        writeId: entry.writeId,
        verb: entry.verb,
        table: entry.table,
        rowId: entry.rowId,
        op: entry.op,
        createdAt: entry.createdAt,
      }));
    const changed = pending.length !== this.#pendingSnapshot.count ||
      pending.some((entry, index) =>
        this.#pendingSnapshot.writes[index]?.writeId !== entry.writeId
      );
    if (changed) this.#pendingSnapshot = { count: pending.length, writes: pending };
    this.#environment.updateDiagnostics((diagnostics) =>
      diagnostics.journaledPendingWrites = pending.length
    );
    for (const listener of this.#listeners) listener();
  }
}

let defaultLedger: WriteLedger | null = null;

function createDefaultLedger(): WriteLedger {
  const ledger = new WriteLedger({
    getDb: async () => (await getRuntime()).db,
    syncConfigured: syncing,
    storage: createDefaultJournalStorage(appId),
    resolveTable: (name) => findRuntimeTable(name),
    resolveEffectUnit,
    subscribeRuntimeRecreation(listener) {
      globalThis.addEventListener(runtimeRecreatedEvent, listener);
      return () => globalThis.removeEventListener(runtimeRecreatedEvent, listener);
    },
    updateDiagnostics: updateRuntimeDiagnostics,
    now: Date.now,
    // Every write — verbs and table mutations alike — passes the
    // schema-compatibility gate and holds the cross-tab write lock for its
    // local-durability window, exactly like the direct table-store surface.
    async guardWrite() {
      await assertSchemaWritable();
      return await acquireUpgradeWriteLock();
    },
  });
  // Arming is best-effort here: a runtime that cannot open (an unsupported
  // browser, a prerender pass) surfaces through its own boot diagnostics.
  void ledger.arm().catch(() => undefined);
  return ledger;
}

/** The package-wide ledger for the current document, created and armed lazily. */
export function getWriteLedger(): WriteLedger {
  defaultLedger ??= createDefaultLedger();
  return defaultLedger;
}

/**
 * Arms the package-wide ledger at boot so journaled writes reconcile and
 * outstanding effect obligations re-run before any island mounts.
 */
export function armWriteLedger(): Promise<void> {
  return getWriteLedger().arm();
}

// The runtime half of the schema-declared verb surface: importing the runtime
// package installs dispatch, so verbs work wherever islands import hooks.
setMutationRuntime({
  dispatch: (descriptor, args) => getWriteLedger().performVerb(descriptor, args),
  recordLog: (label, context) =>
    updateRuntimeDiagnostics((diagnostics) =>
      recordEffectLogEntry(diagnostics, {
        label,
        verb: context.verb,
        table: context.table,
        rowId: context.rowId,
        fate: context.fate,
        at: Date.now(),
      })
    ),
  unitRegistered: (name) => defaultLedger?.retryObligationsFor(name),
});

import.meta.hot?.dispose(() => {
  defaultLedger?.dispose();
  defaultLedger = null;
});
