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
 * The row snapshot an effect handler receives: always the row id, plus the
 * journaled columns — the full row for inserts, the changed columns for
 * updates, and only the id for removes.
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
  /** The written row's id. */
  rowId: string;
  /** Which fate settled the write. */
  fate: "synced" | "rejected";
  /**
   * Why a `rejected` write settled: `denied` for a store verdict, `expired`
   * for an intent retired past its lifespan; `null` on the `synced` fate.
   */
  cause: "denied" | "expired" | null;
  /** The adjudicated rejection code, on the `rejected` fate. */
  code: string | null;
  /** The adjudicated rejection reason, on the `rejected` fate. */
  reason: string | null;
};

/** The action and compensation handlers one effect unit pairs. */
export type EffectHandlers<Row> = {
  /** Runs on the originating device once the store confirms the write. */
  onSynced?: (row: EffectRow<Row>, context: EffectContext) => void | Promise<void>;
  /**
   * Runs on the originating device when the store adjudicates the write and
   * denies it permanently. Compensates optimistic state that was shown to the
   * user; a synchronous local refusal never fires it.
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
  expiresAfter?: number;
  /** Failing attempts before quarantine retires the obligation. Default 5. */
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

/** Declares that a verb inserts rows into `table`. */
export function insert<T, Init>(table: TableProxy<T, Init>): MutationOp<T, Init, "insert"> {
  return { kind: "insert", table };
}

/** Declares that a verb updates rows of `table`. */
export function update<T, Init>(table: TableProxy<T, Init>): MutationOp<T, Init, "update"> {
  return { kind: "update", table };
}

/** Declares that a verb removes rows from `table`. */
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
  expires?: number;
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
  readonly expiresMs: number | null;
};

/** The runtime half installed by the package runtime before verbs are called. */
export type MutationRuntime = {
  /** Performs one declared verb call and returns its write handle. */
  dispatch(descriptor: MutationDescriptor, args: readonly unknown[]): WriteHandle<unknown>;
  /** Records one structured {@link log} entry. */
  recordLog(label: string, context: EffectContext): void;
  /** Re-attempts outstanding journal obligations after a late unit registration. */
  unitRegistered?(name: string): void;
};

type EffectsSlot = {
  runtime: MutationRuntime | null;
  effects: Map<string, EffectUnit<{ id: string }>>;
  verbs: Map<string, MutationDescriptor>;
  logs: Map<string, EffectUnit<{ id: string }>>;
};

const slotName = "__LOFI_EFFECT_DECLARATIONS__";
const effectsGlobal = globalThis as typeof globalThis & { [slotName]?: EffectsSlot };

function slot(): EffectsSlot {
  effectsGlobal[slotName] ??= {
    runtime: null,
    effects: new Map(),
    verbs: new Map(),
    logs: new Map(),
  };
  return effectsGlobal[slotName];
}

/** Installed by the package runtime; author code never calls this. */
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
    expiresAfterMs: options.expiresAfter ?? null,
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
 * Declares a typed, callable verb: a named mutation over one table operation,
 * carrying its effect units. Call sites invoke the verb like a function and
 * receive a `WriteHandle`; `await` resolves at `saved`.
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
  for (const unit of options.effects ?? []) {
    if (seen.has(unit.effectName)) {
      throw new Error(`mutation "${name}" declares effect "${unit.effectName}" twice`);
    }
    seen.add(unit.effectName);
    units.push(unit as EffectUnit<{ id: string }>);
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
    expiresMs: options.expires ?? null,
  };
  state.verbs.set(name, descriptor);
  const verb = (...args: readonly unknown[]) => requireRuntime().dispatch(descriptor, args);
  return verb as MutationVerb<MutationOp<T, Init, Kind>>;
}
