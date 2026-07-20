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
  isPermanentEffectError,
  type MutationDescriptor,
  resolveEffectUnit,
  setMutationRuntime,
} from "../schema/effects.ts";
import { appId, syncing } from "./config.ts";
import {
  recordEffectDebugEvent,
  recordEffectLogEntry,
  recordEffectTrace,
  type RuntimeDiagnostics,
} from "./diagnostics.ts";
import { createDefaultNoticeStorage, type NoticeEntry, NoticeQueue } from "./notice-queue.ts";
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
import { createWriteHandle, type WriteHandle, type WriteHandleController } from "./write-handle.ts";
import {
  createDefaultJournalStorage,
  hashJournalValue,
  type JournalEffectState,
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
  /**
   * True once the verb's declared lifespan has passed while the write is
   * still pending. Surfacing only: the runtime cannot withdraw a locally
   * accepted write, so an overdue intent is reported, never retired.
   */
  expired: boolean;
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
  /** The intent's lifespan in milliseconds, or `null` for none. */
  expiresAfterMs?: number | null;
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

/** The narrow table surface boot-reconciliation probes query by row id. */
export type ProbeTable = { where(input: Record<string, unknown>): unknown };

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
  /** How often retention is swept while the ledger runs. Default 30 seconds. */
  sweepIntervalMs?: number;
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

function hashesMatch(
  hashKey: string,
  journaled: Record<string, string>,
  row: Record<string, unknown>,
): boolean {
  for (const [key, digest] of Object.entries(journaled)) {
    if (key === "id") continue;
    if (hashJournalValue(hashKey, normalized(row[key]) ?? null) !== digest) return false;
  }
  return true;
}

// The default quarantine bound: failing attempts before an obligation
// retires as failed-permanent instead of re-arming forever.
const defaultMaxAttempts = 5;

type RetiredEffectStatus = "done" | "expired" | "failed-permanent";

function isRetired(status: JournalEffectState["status"]): status is RetiredEffectStatus {
  return status === "done" || status === "expired" || status === "failed-permanent";
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
  // Controllers are the mutator half of issued handles; the ledger is the
  // only holder, which is what keeps handle settlement unforgeable.
  #controllers = new Map<string, WriteHandleController<unknown>>();
  readonly #liveRows = new Map<string, Record<string, unknown>>();
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
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
    const { handle, controller } = createWriteHandle<T>(crypto.randomUUID());
    const db = this.#db;
    const guard = this.#environment.guardWrite;
    if (db && !guard) {
      this.#execute(
        db,
        request,
        options,
        handle as WriteHandle<unknown>,
        controller as WriteHandleController<unknown>,
      );
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
        controller.fail(error);
        return;
      }
      try {
        const openDb = await this.#withDb();
        this.#execute(
          openDb,
          request,
          options,
          handle as WriteHandle<unknown>,
          controller as WriteHandleController<unknown>,
        );
      } catch (error) {
        controller.fail(error);
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
    const options: LedgerWriteOptions = {
      verb: descriptor.verbName,
      units: descriptor.units,
      expiresAfterMs: descriptor.expiresAfterMs,
    };
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
      if (state && !isRetired(state.status)) void this.#runObligation(entry, effectName);
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
    if (this.#sweepTimer !== null) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
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
    // Retention first: obligations whose delivery window closed while the
    // device was away retire before anything re-arms.
    this.#sweepRetention();
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
    if (this.#sweepTimer === null && !this.#disposed) {
      this.#sweepTimer = setInterval(
        () => this.#sweepRetention(),
        this.#environment.sweepIntervalMs ?? 30_000,
      );
      // A periodic bookkeeping timer must never keep a process alive.
      (this.#sweepTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  // Retention: delivery windows close, overdue intents surface. Runs at boot
  // and periodically while the ledger lives.
  #sweepRetention(): void {
    if (this.#disposed) return;
    const now = this.#environment.now();
    for (const entry of Object.values(this.#journal.document.writes)) {
      if (entry.stage === "saved") continue;
      for (const [name, state] of Object.entries(entry.effects)) {
        if (isRetired(state.status)) continue;
        if (this.#running.has(journalIdFor(entry.writeId, name))) continue;
        if (state.expiresAt !== null && now > state.expiresAt) {
          this.#retireObligation(entry, name, "expired");
        }
      }
    }
    this.#afterChange();
  }

  #retireObligation(
    entry: JournalWriteRecord,
    effectName: string,
    status: "expired" | "failed-permanent",
  ): void {
    const state = entry.effects[effectName];
    if (!state || isRetired(state.status)) return;
    this.#journal.update(() => {
      state.status = status;
    });
    this.#environment.updateDiagnostics((diagnostics) => {
      if (status === "expired") diagnostics.expiredObligations += 1;
      else diagnostics.quarantinedObligations += 1;
    });
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
      const confirmed = current.op === "remove" ? row === undefined : row !== undefined &&
        hashesMatch(this.#journal.document.hashKey, current.rowHashes, row);
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
    controller: WriteHandleController<unknown>,
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
    // The journal persists keyed hashes, never values: enough for the boot
    // equality probe without a second plaintext copy of row data. The values
    // themselves live only in this session's memory, for handler delivery.
    const hashKey = this.#journal.document.hashKey;
    const rowHashes: Record<string, string> = {};
    for (const [column, value] of Object.entries(rowSnapshot)) {
      if (column === "id") continue;
      rowHashes[column] = hashJournalValue(hashKey, normalized(value) ?? null);
    }
    const createdAt = this.#environment.now();
    const entry: JournalWriteRecord = {
      writeId: handle.writeId,
      verb: options.verb ?? null,
      table: (request.table as { _table?: string })._table ?? "",
      op: request.kind,
      rowId,
      batchId: vendor.batchId === undefined ? null : String(vendor.batchId),
      rowHashes,
      stage: "saved",
      cause: null,
      code: null,
      reason: null,
      createdAt,
      expiresAt: options.expiresAfterMs != null ? createdAt + options.expiresAfterMs : null,
      effects: Object.fromEntries(
        (options.units ?? []).map((unit) => [
          unit.effectName,
          {
            status: "pending" as const,
            attempts: 0,
            lastError: null,
            expiresAt: unit.expiresAfterMs != null ? createdAt + unit.expiresAfterMs : null,
          },
        ]),
      ),
    };
    this.#journal.update((document) => {
      document.writes[entry.writeId] = entry;
    });
    this.#liveRows.set(entry.writeId, rowSnapshot);
    this.#controllers.set(entry.writeId, controller);
    controller.setBatchId(entry.batchId);
    // Pre-stage the insert's row value so a fast global confirmation can
    // never resolve the stage promises before the value is known.
    if (request.kind === "insert") controller.advance("saving", vendor.value);
    this.#afterChange();
    void this.#settle(vendor, entry, controller);
  }

  async #settle(
    vendor: VendorWrite,
    entry: JournalWriteRecord,
    controller: WriteHandleController<unknown>,
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
      this.#controllers.delete(entry.writeId);
      controller.fail(error);
      this.#afterChange();
      return;
    }
    controller.advance("saved", value);
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
    this.#controllers.get(current.writeId)?.advance("synced");
    this.#fireUnits(current);
    this.#afterChange();
  }

  #applyVerdict(entry: JournalWriteRecord, code: string | null, reason: string): void {
    const current = this.#journal.document.writes[entry.writeId];
    if (!current || current.stage !== "saved") return;
    if (classifyMutationError(code) !== "permanent") return;
    this.#journal.update(() => {
      current.stage = "rejected";
      current.cause = "denied";
      current.code = code;
      current.reason = reason;
    });
    this.#controllers.get(current.writeId)?.reject({ cause: "denied", code, reason });
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
    if (!state || isRetired(state.status) || this.#running.has(journalId)) return;
    // A closed delivery window retires the obligation before any handler
    // consideration: the write happened, so compensation would be wrong, and
    // the receiver's idempotency window is assumed gone.
    if (state.expiresAt !== null && this.#environment.now() > state.expiresAt) {
      this.#retireObligation(entry, effectName, "expired");
      this.#afterChange();
      return;
    }
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
    try {
      const row = await this.#resolveHandlerRow(entry, fate);
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
        op: entry.op,
        rowId: entry.rowId,
        writeCreatedAt: entry.createdAt,
        fate,
        cause: fate === "rejected" ? entry.cause ?? "denied" : null,
        code: entry.code,
        reason: entry.reason,
      };
      try {
        await handler(row as EffectRow<{ id: string }>, context);
        this.#journal.update(() => {
          state.status = "done";
          state.lastError = null;
        });
      } catch (error) {
        const maxAttempts = unit.maxAttempts ?? defaultMaxAttempts;
        this.#journal.update(() => {
          state.status = "failed";
          state.lastError = error instanceof Error ? error.message : String(error);
        });
        this.#environment.updateDiagnostics((diagnostics) =>
          diagnostics.effectHandlerFailures += 1
        );
        // A handler that declared its failure permanent retires now: retrying
        // a request the receiver will keep refusing only burns the budget and
        // delays the quarantine diagnostic. Otherwise a failing handler
        // re-arms until repeated attempts quarantine it.
        if (isPermanentEffectError(error) || state.attempts >= maxAttempts) {
          this.#retireObligation(entry, effectName, "failed-permanent");
        }
      }
    } finally {
      this.#running.delete(journalId);
      this.#afterChange();
    }
  }

  /**
   * The row a handler receives. Same-session deliveries pass the in-memory
   * write snapshot. After a reload the journal holds no values: a synced
   * write's row is fetched live from the store (sync confirmed it exists); a
   * rejected write was rolled back by the engine, so compensation receives
   * write identity only — the row id and the structured cause.
   */
  async #resolveHandlerRow(
    entry: JournalWriteRecord,
    fate: "synced" | "rejected",
  ): Promise<Record<string, unknown>> {
    const live = this.#liveRows.get(entry.writeId);
    if (live) return live;
    if (fate === "synced" && entry.op !== "remove") {
      const db = this.#db;
      const table = this.#environment.resolveTable(entry.table);
      if (db && table) {
        try {
          const rows = await db.all(
            table.where({ id: entry.rowId }) as never,
            { tier: "local" },
          ) as Array<Record<string, unknown>>;
          const row = rows.find((candidate) => candidate.id === entry.rowId);
          if (row) return row;
        } catch {
          // Fall through to identity-only delivery below.
        }
      }
    }
    return { id: entry.rowId };
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
        .every((state) => isRetired(state.status));
      if (settled) {
        // Fully settled entries leave the journal; failed-but-not-quarantined
        // obligations keep theirs so the next boot can re-arm the handler.
        this.#journal.update(() => {
          delete document.writes[entry.writeId];
        });
        this.#controllers.delete(entry.writeId);
        this.#liveRows.delete(entry.writeId);
      }
    }
    const now = this.#environment.now();
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
        expired: entry.expiresAt !== null && now > entry.expiresAt,
      }));
    const changed = pending.length !== this.#pendingSnapshot.count ||
      pending.some((entry, index) =>
        this.#pendingSnapshot.writes[index]?.writeId !== entry.writeId ||
        this.#pendingSnapshot.writes[index]?.expired !== entry.expired
      );
    if (changed) this.#pendingSnapshot = { count: pending.length, writes: pending };
    this.#environment.updateDiagnostics((diagnostics) => {
      diagnostics.journaledPendingWrites = pending.length;
      diagnostics.expiredPendingWrites = pending.filter((entry) => entry.expired).length;
    });
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

let defaultNotices: NoticeQueue | null = null;

/**
 * The package-wide durable notice queue behind `s.notice`, created lazily and
 * kept in sync with the `activeNotices` diagnostic. Public read/subscribe/
 * dismiss surfaces ({@link listNotices}, {@link subscribeNotices},
 * {@link dismissNotice}) are re-exported from the runtime entry.
 */
export function getNoticeQueue(): NoticeQueue {
  if (!defaultNotices) {
    defaultNotices = new NoticeQueue(
      createDefaultNoticeStorage(appId),
      Date.now,
      (count) =>
        updateRuntimeDiagnostics((diagnostics) => {
          diagnostics.activeNotices = count;
        }),
    );
    // Load persisted entries and publish the initial count; a storage-less or
    // prerender context simply starts empty.
    void defaultNotices.load()
      .then(() =>
        updateRuntimeDiagnostics((diagnostics) => {
          diagnostics.activeNotices = defaultNotices?.list().length ?? 0;
        })
      )
      .catch(() => undefined);
  }
  return defaultNotices;
}

/** The live durable notices for the current document. */
export function listNotices(): readonly NoticeEntry[] {
  return getNoticeQueue().list();
}

/** Subscribes to notice-queue changes; returns an unsubscribe function. */
export function subscribeNotices(listener: () => void): () => void {
  return getNoticeQueue().subscribe(listener);
}

/** Dismisses one durable notice by id. */
export function dismissNotice(id: string): void {
  getNoticeQueue().dismiss(id);
}

/** Dismisses every durable notice. */
export function dismissAllNotices(): void {
  getNoticeQueue().dismissAll();
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
  recordTrace: (label, context) =>
    updateRuntimeDiagnostics((diagnostics) =>
      recordEffectTrace(diagnostics, {
        label,
        verb: context.verb,
        rowId: context.rowId,
        fate: context.fate,
        durationMs: Math.max(0, Date.now() - context.writeCreatedAt),
        at: Date.now(),
      })
    ),
  recordDebug: (event, context) =>
    updateRuntimeDiagnostics((diagnostics) =>
      recordEffectDebugEvent(diagnostics, {
        verb: context.verb,
        journalId: context.journalId,
        event,
        at: Date.now(),
      })
    ),
  enqueueNotice: (input, context) =>
    getNoticeQueue().enqueue({
      id: context.journalId,
      message: input.message,
      tone: input.tone,
      ttlMs: input.ttlMs,
    }),
  applyMark: async (table, rowId, patch) => {
    await getWriteLedger().perform({ kind: "update", table, id: rowId, patch }).saved;
  },
  unitRegistered: (name) => defaultLedger?.retryObligationsFor(name),
});

import.meta.hot?.dispose(() => {
  defaultLedger?.dispose();
  defaultLedger = null;
  defaultNotices = null;
});
