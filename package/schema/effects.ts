/// <reference path="../runtime/env.d.ts" />
/**
 * Author-declared verbs and effect units.
 *
 * Tables are the nouns of an application: they declare what exists, and
 * policies attach to them because a policy must be safe to evaluate on every
 * replica. Mutations are the verbs: they declare what happens, and
 * consequences attach to them because a consequence needs an owner — the
 * device that performed the intent. This module is the declarative half of
 * that grammar: {@link effect} pairs an action with its compensation under a
 * durable name, {@link mutation} binds effect units to a named verb once, at
 * declaration, so call sites carry nothing. The runtime half journals each
 * unit per write and fires handlers when the write's fate settles.
 *
 * This module stays authoring-only: it declares names, tables, and handlers,
 * and delegates every write to the runtime installed through
 * {@link setMutationRuntime}.
 *
 * @module
 */

import type { TableProxy } from "jazz-tools";
import type { WriteHandle } from "../runtime/write-handle.ts";

/**
 * The row an effect handler receives. In the session that performed the write
 * it is the write's snapshot: the full row for inserts, the changed columns
 * for updates, only the id for removes. After a reload the journal holds no
 * column values: a `synced` handler receives the row fetched live from the
 * store — the final merged state — and a `rejected` handler receives the id
 * alone, because the engine rolled the row back and identity plus
 * {@link EffectContext.cause} is all that remains. Treat every column except
 * `id` as optional.
 */
export type EffectRow<Row> = Partial<Row> & { id: string };

/**
 * Delivery metadata passed to every effect handler. Delivery is
 * at-least-once: a crash between handler start and journal completion re-runs
 * the handler at the next boot, so handlers calling external services should
 * pass {@link EffectContext.journalId} as an idempotency key.
 */
export type EffectContext = {
  /** The `(write id, effect name)` idempotency key for this obligation. */
  journalId: string;
  /** The journaled write's stable id. */
  writeId: string;
  /** The declaring verb's name, or `null` for writes without a verb. */
  verb: string | null;
  /** The written table's name. */
  table: string;
  /** Which operation the write performed. */
  op: "insert" | "update" | "remove";
  /** The written row's id. */
  rowId: string;
  /** Epoch milliseconds when the write was journaled, for latency spans. */
  writeCreatedAt: number;
  /** Which fate settled the write. */
  fate: "synced" | "rejected";
  /**
   * Why a `rejected` write settled: `denied` for a store verdict; `null` on
   * the `synced` fate. `expired` is reserved for store-side expiry
   * enforcement — at the pinned runtime an overdue intent is surfaced, never
   * retired ({@link MutationOptions.expiresAfterMs}), so rejections today
   * carry
   * `denied`.
   */
  cause: "denied" | "expired" | null;
  /** The adjudicated rejection code, on the `rejected` fate. */
  code: string | null;
  /** The adjudicated rejection reason, on the `rejected` fate. */
  reason: string | null;
};

/**
 * Thrown from an effect handler to retire the obligation immediately instead
 * of re-arming it. Delivery is at-least-once by default: an ordinary thrown
 * error is *retryable* — the handler re-runs at the next boot until it
 * succeeds or {@link EffectUnitOptions.maxAttempts} quarantines it. Some
 * failures are known to be *permanent* — a webhook receiver answered `400`, a
 * row a handler needed is gone for good — and retrying only burns attempts and
 * delays the quarantine diagnostic. Throwing this retires the obligation now,
 * counted as a permanent handler failure. The message reaches diagnostics.
 *
 * @example
 * ```ts
 * s.effect("charge", app.orders, {
 *   onSynced: async (order, { journalId }) => {
 *     const res = await fetch(url, { headers: { "Idempotency-Key": journalId } });
 *     if (res.status >= 400 && res.status < 500) {
 *       throw new PermanentEffectError(`charge refused: ${res.status}`);
 *     }
 *     if (!res.ok) throw new Error(`charge transient failure: ${res.status}`);
 *   },
 * });
 * ```
 */
export class PermanentEffectError extends Error {
  /** Stable class name for diagnostics and the ledger's severity check. */
  override readonly name = "PermanentEffectError";
  /** Creates the permanent-failure signal with a diagnostics message. */
  constructor(message: string) {
    super(message);
  }
}

/** True when a handler failure asked to retire rather than retry. */
export function isPermanentEffectError(error: unknown): error is PermanentEffectError {
  return error instanceof PermanentEffectError;
}

/** The action and compensation handlers one effect unit pairs. */
export type EffectHandlers<Row> = {
  /** Runs on the originating device once the store confirms the write. */
  onSynced?: (row: EffectRow<Row>, context: EffectContext) => void | Promise<void>;
  /**
   * Runs on the originating device when the store adjudicates the write and
   * denies it permanently. The engine has already rolled the row out of local
   * query results, so compensate what the user was told — notices, external
   * calls, follow-up writes — not the row data. After a reload the payload is
   * identity-only ({@link EffectRow}). A synchronous local refusal throws
   * from the verb call instead and never fires this handler.
   */
  onRejected?: (row: EffectRow<Row>, context: EffectContext) => void | Promise<void>;
};

/**
 * Retention options for one effect unit: how long delivery may lag the write,
 * and how many failing attempts are made before quarantine.
 */
export type EffectUnitOptions = {
  /**
   * The delivery window in milliseconds, measured from the write. When the
   * write synced but this obligation could not be delivered inside the
   * window, the obligation retires as expired and no handler fires — the
   * write happened, so compensation would be wrong. External-tier handlers
   * whose receivers keep finite idempotency windows should set this.
   */
  expiresAfterMs?: number;
  /**
   * Failing handler attempts before quarantine: past this count the
   * obligation retires as failed-permanent instead of re-arming at every
   * boot. The retirement is counted in runtime diagnostics and the journal
   * entry becomes prunable.
   *
   * @default 5
   */
  maxAttempts?: number;
};

/**
 * A named, reusable pairing of action and compensation. The name is the
 * durable identity the journal uses to re-arm handlers after a reload; a
 * mutation declares its units once, at the verb declaration.
 */
export type EffectUnit<Row = { id: string }> = {
  /** The app-unique durable name of this unit. */
  readonly effectName: string;
  /** The unit's handlers. */
  readonly handlers: EffectHandlers<Row>;
  /** The delivery window in milliseconds, or `null` for none. */
  readonly expiresAfterMs?: number | null;
  /** Failing attempts before quarantine retires the obligation. */
  readonly maxAttempts?: number;
  /**
   * Set on a built-in unit the author did not name (`s.notice`, `s.mark`,
   * `s.chain`). Such a unit is registered lazily, when a {@link mutation}
   * includes it: its durable name becomes `<verb>#<position>` — stable across
   * reloads because it derives from the author-chosen verb name and the unit's
   * fixed position in that verb's `effects`, not from module-evaluation order.
   * Absent on named units, which register at declaration.
   */
  readonly anonymousPrefix?: string;
};

/** Which operation a {@link MutationOp} performs. */
export type MutationOpKind = "insert" | "update" | "remove";

/** A table operation a verb is declared over; see {@link insert}, {@link update}, {@link remove}. */
export type MutationOp<T, Init, Kind extends MutationOpKind = MutationOpKind> = {
  /** The operation kind. */
  readonly kind: Kind;
  /** The declared table the verb writes. */
  readonly table: TableProxy<T, Init>;
};

/**
 * Declares that a verb inserts rows into `table`. A {@link mutation} declared
 * over this op is called as `(values) => WriteHandle<Row>`; `await` resolves
 * at `saved` with the created row.
 */
export function insert<T, Init>(table: TableProxy<T, Init>): MutationOp<T, Init, "insert"> {
  return { kind: "insert", table };
}

/**
 * Declares that a verb updates rows of `table`. A {@link mutation} declared
 * over this op is called as `(id, patch) => WriteHandle<void>`; `await`
 * resolves at `saved`.
 */
export function update<T, Init>(table: TableProxy<T, Init>): MutationOp<T, Init, "update"> {
  return { kind: "update", table };
}

/**
 * Declares that a verb removes rows from `table`. A {@link mutation} declared
 * over this op is called as `(id) => WriteHandle<void>`; `await` resolves at
 * `saved`.
 */
export function remove<T, Init>(table: TableProxy<T, Init>): MutationOp<T, Init, "remove"> {
  return { kind: "remove", table };
}

/** A callable verb declared over an insert operation. */
export type InsertVerb<T, Init> = (values: Init) => WriteHandle<T>;
/** A callable verb declared over an update operation. */
export type UpdateVerb<Init> = (id: string, patch: Partial<Init>) => WriteHandle<void>;
/** A callable verb declared over a remove operation. */
export type RemoveVerb = (id: string) => WriteHandle<void>;

/** The callable shape of a declared verb, derived from its operation. */
export type MutationVerb<Op> = Op extends MutationOp<infer T, infer Init, "insert">
  ? InsertVerb<T, Init>
  : Op extends MutationOp<infer _T, infer Init, "update"> ? UpdateVerb<Init>
  : Op extends MutationOp<infer _T, infer _Init, "remove"> ? RemoveVerb
  : never;

/** Options accepted by {@link mutation}: declared units plus inline sugar. */
export type MutationOptions<Row> = {
  /** The effect units this verb carries; declared once, reused by every call site. */
  effects?: readonly EffectUnit<Row>[];
  /** Inline sugar for an implicit single unit named after the verb. */
  onSynced?: EffectHandlers<Row>["onSynced"];
  /** Inline sugar for an implicit single unit named after the verb. */
  onRejected?: EffectHandlers<Row>["onRejected"];
  /**
   * The intent's lifespan in milliseconds. A write of this verb still pending
   * past its lifespan is surfaced through pending-writes state and
   * diagnostics. The engine offers no withdrawal for a locally accepted write
   * at the pinned runtime, so an overdue intent is reported, never retired:
   * retiring it as rejected could fire compensation for a write that later
   * syncs anyway.
   */
  expiresAfterMs?: number;
};

/** The registered declaration the runtime dispatches for one verb. */
export type MutationDescriptor = {
  /** The verb's app-unique name. */
  readonly verbName: string;
  /** The operation the verb performs. */
  readonly op: MutationOp<unknown, unknown>;
  /** The verb's effect units, implicit unit included. */
  readonly units: readonly EffectUnit<{ id: string }>[];
  /** The intent's lifespan in milliseconds, or `null` for none. */
  readonly expiresAfterMs: number | null;
};

/**
 * One durable notice a {@link notice} unit enqueues. The queue is persistent
 * and UI-agnostic: entries may be created at a boot re-arm with nothing
 * mounted, and a component renders them later. `tone` classifies the message
 * for the render; `ttlMs` bounds its life when the author sets no explicit
 * dismissal.
 */
export type NoticeInput = {
  /** The user-facing message. */
  message: string;
  /** How to classify the message for rendering. */
  tone: "info" | "success" | "warning" | "error";
  /** Lifespan in milliseconds before the queue retires the entry, or `null`. */
  ttlMs: number | null;
};

/** The runtime half installed by the package runtime before verbs are called. */
export type MutationRuntime = {
  /** Performs one declared verb call and returns its write handle. */
  dispatch(descriptor: MutationDescriptor, args: readonly unknown[]): WriteHandle<unknown>;
  /** Records one structured {@link log} entry. */
  recordLog(label: string, context: EffectContext): void;
  /** Records one {@link trace} span from the write's journaling to its fate. */
  recordTrace?(label: string | null, context: EffectContext): void;
  /** Records one {@link debug} timeline event; a no-op in production builds. */
  recordDebug?(event: string, context: EffectContext): void;
  /** Enqueues one durable {@link notice} entry. */
  enqueueNotice?(input: NoticeInput, context: EffectContext): void;
  /**
   * Patches a row on behalf of a {@link mark} unit: a bare update carrying no
   * further units, so write fate becomes replicated row data without
   * recursion. Resolves at local durability; rejects if the row is gone.
   */
  applyMark?(
    table: TableProxy<unknown, unknown>,
    rowId: string,
    patch: Record<string, unknown>,
  ): Promise<void>;
  /** Re-attempts outstanding journal obligations after a late unit registration. */
  unitRegistered?(name: string): void;
};

type EffectsSlot = {
  runtime: MutationRuntime | null;
  effects: Map<string, EffectUnit<{ id: string }>>;
  verbs: Map<string, MutationDescriptor>;
  logs: Map<string, EffectUnit<{ id: string }>>;
  /** Cache for content-named built-ins (trace, debug, webhook) shared by name. */
  cache: Map<string, EffectUnit<{ id: string }>>;
};

const slotName = "__LOFI_EFFECT_DECLARATIONS__";
const effectsGlobal = globalThis as typeof globalThis & { [slotName]?: EffectsSlot };

function slot(): EffectsSlot {
  effectsGlobal[slotName] ??= {
    runtime: null,
    effects: new Map(),
    verbs: new Map(),
    logs: new Map(),
    cache: new Map(),
  };
  return effectsGlobal[slotName];
}

/**
 * Installs the runtime half verbs dispatch through. The package runtime
 * installs it at boot; application code never calls this. Tests install a
 * deterministic fake to unit-test verbs without a booted runtime.
 */
export function setMutationRuntime(runtime: MutationRuntime): void {
  slot().runtime = runtime;
}

/** Resolves a registered effect unit by its durable name, for the runtime. */
export function resolveEffectUnit(name: string): EffectUnit<{ id: string }> | null {
  return slot().effects.get(name) ?? null;
}

/** Clears every declaration; deterministic-test seam. */
export function clearEffectDeclarations(): void {
  const state = slot();
  state.effects.clear();
  state.verbs.clear();
  state.logs.clear();
  state.cache.clear();
}

// During dev hot replacement author modules re-evaluate routinely; the newest
// declaration replaces its predecessor under the same durable name. Outside
// dev, a duplicate name is a real collision and fails fast.
const hotReplacement = Boolean(import.meta.hot);

function registerUnit(unit: EffectUnit<{ id: string }>): void {
  const state = slot();
  const existing = state.effects.get(unit.effectName);
  if (existing && existing !== unit && !hotReplacement) {
    throw new Error(
      `effect name "${unit.effectName}" is already declared; effect names are the journal's ` +
        `durable identities and must be unique per app`,
    );
  }
  state.effects.set(unit.effectName, unit);
  // A unit declared after boot may satisfy obligations journaled before the
  // reload; the runtime re-attempts them on registration.
  state.runtime?.unitRegistered?.(unit.effectName);
}

/**
 * Declares a named, reusable, typed effect unit over one table.
 *
 * The name is durable: the journal re-arms this unit's handlers by name after
 * a reload, so renaming a unit orphans obligations journaled under the old
 * name. Names must be unique per app; a duplicate declaration throws.
 *
 * Handlers run once, on the originating device, with at-least-once delivery:
 * a crash between handler start and journal completion re-runs the handler at
 * the next boot, so handlers that call external services should pass
 * {@link EffectContext.journalId} as the idempotency key.
 *
 * @example
 * ```ts
 * const chargeCard = s.effect("chargeCard", app.schema.orders, {
 *   onSynced: async (order, { journalId }) => {
 *     // The world accepted the order. journalId is the idempotency key.
 *   },
 *   onRejected: async (order) => {
 *     // The order never happened: compensate what the user saw.
 *   },
 * });
 * ```
 *
 * @throws Error when `name` is empty or already declared by a different unit;
 * in dev hot replacement the newest declaration replaces its predecessor
 * instead of throwing.
 */
export function effect<T extends { id: string }, Init>(
  name: string,
  table: TableProxy<T, Init>,
  handlers: EffectHandlers<T>,
  options: EffectUnitOptions = {},
): EffectUnit<T> {
  if (!name.trim()) throw new Error("effect name must not be empty");
  void table;
  const unit: EffectUnit<T> = {
    effectName: name,
    handlers,
    expiresAfterMs: options.expiresAfterMs ?? null,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  };
  registerUnit(unit as EffectUnit<{ id: string }>);
  return unit;
}

/**
 * A built-in effect unit that records a structured entry in runtime
 * diagnostics on either fate. Repeated calls with one label return the same
 * unit, so a label can be shared by several verbs.
 *
 * @example
 * ```ts
 * export const addTask = s.mutation("addTask", s.insert(app.schema.tasks), {
 *   effects: [s.log("task-writes")],
 * });
 * // Each addTask write records a "task-writes" diagnostics entry when it
 * // syncs or is rejected.
 * ```
 */
export function log(label: string): EffectUnit<{ id: string }> {
  if (!label.trim()) throw new Error("log label must not be empty");
  const state = slot();
  const name = `log:${label}`;
  let unit = state.logs.get(name);
  if (!unit) {
    const record = (_row: EffectRow<{ id: string }>, context: EffectContext) => {
      requireRuntime().recordLog(label, context);
    };
    unit = { effectName: name, handlers: { onSynced: record, onRejected: record } };
    state.logs.set(name, unit);
    registerUnit(unit);
  }
  return unit;
}

function requireRuntime(): MutationRuntime {
  const runtime = slot().runtime;
  if (!runtime) {
    throw new Error(
      "the lofi runtime is not installed; import @nzip/lofi (or @nzip/lofi/preact) in the " +
        "module that calls this verb",
    );
  }
  return runtime;
}

/**
 * The installed runtime, or a thrown explanation when none is. The built-in
 * effect library ({@link EffectUnit} factories in `effect-library.ts`) reaches
 * the runtime through this so it stays on the public authoring surface — the
 * same requirement custom units must meet.
 */
export function requireMutationRuntime(): MutationRuntime {
  return requireRuntime();
}

/**
 * Builds an anonymous built-in unit (a notice, mark, or chain the author did
 * not name) without registering it. Registration is deferred to
 * {@link mutation}, which names it `<verb>#<position>` from the verb it is
 * attached to and its position in that verb's `effects`. That identity is
 * stable across reloads regardless of which module evaluates first, so a
 * journaled obligation always re-arms against the same logical unit; the only
 * way to orphan one is to reorder the effects within its own verb.
 */
export function anonymousUnit<Row extends { id: string }>(
  prefix: string,
  handlers: EffectHandlers<Row>,
  options: EffectUnitOptions = {},
): EffectUnit<Row> {
  return {
    effectName: "",
    handlers,
    anonymousPrefix: prefix,
    expiresAfterMs: options.expiresAfterMs ?? null,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  };
}

/**
 * Returns the shared built-in unit registered under `name`, building and
 * registering it on first use. For content-named observation and external
 * units (`s.trace`, `s.debug`, `s.webhook`) whose whole identity is their
 * name, so reusing one across verbs shares a single unit instead of colliding
 * — the same discipline {@link log} follows.
 */
export function cachedBuiltin<Row extends { id: string }>(
  name: string,
  build: () => EffectHandlers<Row>,
  options: EffectUnitOptions = {},
): EffectUnit<Row> {
  const state = slot();
  const existing = state.cache.get(name);
  if (existing) return existing as unknown as EffectUnit<Row>;
  const unit: EffectUnit<Row> = {
    effectName: name,
    handlers: build(),
    expiresAfterMs: options.expiresAfterMs ?? null,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  };
  state.cache.set(name, unit as unknown as EffectUnit<{ id: string }>);
  registerUnit(unit as unknown as EffectUnit<{ id: string }>);
  return unit;
}

/**
 * Declares a typed, callable verb: a named mutation over one table operation,
 * carrying its effect units. Call sites invoke the verb like a function and
 * receive a {@link WriteHandle}; `await` resolves at `saved`.
 *
 * Verb names are app-unique and durable — the journal attributes re-armed
 * obligations through them — and read as imperative verb phrases
 * (`placeOrder`, not `orderInsert`). Inline `onSynced`/`onRejected` are sugar
 * for an implicit single unit named after the verb.
 *
 * @example
 * ```ts
 * export const placeOrder = s.mutation("placeOrder", s.insert(app.schema.orders), {
 *   effects: [chargeCard, s.log("order-placed")],
 * });
 *
 * const write = placeOrder({ item, qty }); // WriteHandle<Order>
 * await write;                             // saved: durable on this device
 * await write.synced;                      // confirmed by the store
 * ```
 *
 * @throws Error at declaration when `name` is empty, already declared
 * (outside dev hot replacement, where the newest declaration replaces its
 * predecessor under the same name), or when `options` list one effect unit
 * twice.
 * @throws Error from a call to the returned verb when the local policy
 * refuses the write: the refusal is synchronous, creates no stage and no
 * journal entry, and fires no effect — see {@link EffectHandlers.onRejected}
 * for the adjudicated case. Calls also throw when the lofi runtime is not
 * installed.
 */
export function mutation<T extends { id: string }, Init, Kind extends MutationOpKind>(
  name: string,
  op: MutationOp<T, Init, Kind>,
  options: MutationOptions<T> = {},
): MutationVerb<MutationOp<T, Init, Kind>> {
  if (!name.trim()) throw new Error("mutation name must not be empty");
  const state = slot();
  const existing = state.verbs.get(name);
  if (existing && !hotReplacement) {
    throw new Error(`mutation name "${name}" is already declared; verb names are unique per app`);
  }
  const units: EffectUnit<{ id: string }>[] = [];
  const seen = new Set<string>();
  const declared = options.effects ?? [];
  for (let index = 0; index < declared.length; index += 1) {
    let unit = declared[index] as EffectUnit<{ id: string }>;
    if (unit.anonymousPrefix !== undefined) {
      // An anonymous built-in (s.notice/s.mark/s.chain) is named and
      // registered here, from the verb it is attached to and its position in
      // this verb's effects — a durable identity independent of module load
      // order. Register a finalized copy so the ledger resolves it at re-arm.
      unit = { ...unit, effectName: `${name}#${index}`, anonymousPrefix: undefined };
      registerUnit(unit);
    }
    if (seen.has(unit.effectName)) {
      throw new Error(`mutation "${name}" declares effect "${unit.effectName}" twice`);
    }
    seen.add(unit.effectName);
    units.push(unit);
  }
  if (options.onSynced || options.onRejected) {
    if (seen.has(name)) {
      throw new Error(
        `mutation "${name}" cannot combine inline handlers with an effect unit named "${name}"`,
      );
    }
    const implicit: EffectUnit<T> = {
      effectName: name,
      handlers: { onSynced: options.onSynced, onRejected: options.onRejected },
    };
    registerUnit(implicit as EffectUnit<{ id: string }>);
    units.push(implicit as EffectUnit<{ id: string }>);
  }
  const descriptor: MutationDescriptor = {
    verbName: name,
    op: op as MutationOp<unknown, unknown>,
    units,
    expiresAfterMs: options.expiresAfterMs ?? null,
  };
  state.verbs.set(name, descriptor);
  const verb = (...args: readonly unknown[]) => requireRuntime().dispatch(descriptor, args);
  return verb as MutationVerb<MutationOp<T, Init, Kind>>;
}
