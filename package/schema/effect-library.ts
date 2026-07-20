/// <reference path="../runtime/env.d.ts" />
/**
 * The built-in effect library: reusable {@link EffectUnit}s tiered by risk,
 * each idempotent by construction so it doubles as a reference implementation
 * of the at-least-once discipline a custom unit author must follow.
 *
 * The tiers are a learning ramp, one new concept each:
 *
 * - **Observation** — {@link trace}, {@link debug}. Cannot change anything;
 *   they only record. (The first observation unit, `s.log`, lives in
 *   `effects.ts` beside the core because the runtime records it directly.)
 * - **Data-internal** — {@link notice}, {@link mark}, {@link chain}. Write
 *   back into the app: a durable message, a status column, a follow-up verb.
 *   Fate stops being a callback and becomes replicated data.
 * - **External** — {@link webhook}. Calls the outside world, where the
 *   idempotency key and a bounded, backed-off retry earn their keep.
 *
 * Every unit here is built on the public authoring surface from `effects.ts`
 * ({@link effect}, {@link EffectContext}, {@link PermanentEffectError}, and the
 * optional runtime capabilities the package runtime installs) — nothing
 * private. The authoring guide points custom-unit authors at these as models.
 *
 * @module
 */

import type { TableProxy } from "jazz-tools";
import type { WriteHandle } from "../runtime/write-handle.ts";
import {
  anonymousEffectName,
  effect,
  type EffectContext,
  type EffectRow,
  type EffectUnit,
  type EffectUnitOptions,
  type NoticeInput,
  PermanentEffectError,
  requireMutationRuntime,
} from "./effects.ts";

// A tableless built-in binds no columns; the core `effect` uses its table
// argument only for row typing, so this placeholder documents the intent in
// one place instead of scattering casts.
const noTable = undefined as unknown as TableProxy<{ id: string }, unknown>;

function tablelessEffect(
  name: string,
  handlers: {
    onSynced?: (row: EffectRow<{ id: string }>, context: EffectContext) => void | Promise<void>;
    onRejected?: (row: EffectRow<{ id: string }>, context: EffectContext) => void | Promise<void>;
  },
  options?: EffectUnitOptions,
): EffectUnit<{ id: string }> {
  return effect(name, noTable, handlers, options);
}

/**
 * Observation unit: a span from the write's journaling to its settled fate,
 * recorded in runtime diagnostics as an OpenTelemetry-shaped event with the
 * saved→synced/rejected latency. Pure instrumentation — it changes no state
 * and cannot fail a write. The optional label groups related spans; without
 * one the verb name labels the span. Repeated calls with one label share a
 * unit, so a label can be reused across verbs.
 *
 * @example
 * ```ts
 * export const placeOrder = s.mutation("placeOrder", s.insert(app.orders), {
 *   effects: [s.trace("checkout")],
 * });
 * ```
 */
export function trace(label?: string): EffectUnit<{ id: string }> {
  if (label !== undefined && !label.trim()) throw new Error("trace label must not be empty");
  const name = label ? `trace:${label}` : "trace";
  const record = (_row: EffectRow<{ id: string }>, context: EffectContext) => {
    requireMutationRuntime().recordTrace?.(label ?? null, context);
  };
  return tablelessEffect(name, { onSynced: record, onRejected: record });
}

/**
 * Observation unit: a development-only timeline entry for each fate an
 * obligation settles, for eyeballing effect delivery in the inspector.
 * Stripped from production builds — in a `PROD` bundle the handlers record
 * nothing, so it costs a closure and no more.
 *
 * @example
 * ```ts
 * export const editNote = s.mutation("editNote", s.update(app.notes), {
 *   effects: [s.debug()],
 * });
 * ```
 */
export function debug(): EffectUnit<{ id: string }> {
  const production = !import.meta.env.DEV;
  const record = (_row: EffectRow<{ id: string }>, context: EffectContext) => {
    if (production) return;
    requireMutationRuntime().recordDebug?.(context.fate, context);
  };
  return tablelessEffect("debug", { onSynced: record, onRejected: record });
}

/** A notice message resolved from the settled row, or a static string. */
export type NoticeResolver<Row> = string | ((row: EffectRow<Row>) => string);

/** Per-fate notice configuration for {@link notice}. */
export type NoticeConfig<Row> = {
  /** The message (or resolver) enqueued when the write syncs. */
  synced?: NoticeResolver<Row>;
  /** The message (or resolver) enqueued when the write is rejected. */
  rejected?: NoticeResolver<Row>;
  /**
   * Lifespan of an enqueued entry before the durable queue retires it. Omit
   * for the queue default; pass `null` to keep the entry until dismissed.
   */
  ttlMs?: number | null;
};

function resolveNotice<Row>(resolver: NoticeResolver<Row>, row: EffectRow<Row>): string {
  return typeof resolver === "function" ? resolver(row) : resolver;
}

/**
 * Data-internal unit: enqueues a durable, user-visible message when the write
 * settles — the fix for the "a rejected write still flashed success" failure
 * mode. The queue is durable and UI-agnostic: an entry created at a boot
 * re-arm survives with nothing mounted, and a component (the built-in notices
 * surface, or an author's) renders it. Toasts are a userland wrapper over the
 * queue, never an imperative call from here.
 *
 * Idempotent by the obligation's journal id: a re-delivered handler enqueues
 * the same keyed entry once, so a crash-and-replay shows one message.
 *
 * @example
 * ```ts
 * export const publish = s.mutation("publish", s.update(app.posts), {
 *   effects: [s.notice<Post>({
 *     synced: "Published.",
 *     rejected: (post) => `Could not publish "${post.title}".`,
 *   })],
 * });
 * ```
 */
export function notice<Row extends { id: string } = { id: string }>(
  config: NoticeConfig<Row>,
): EffectUnit<Row> {
  if (config.synced === undefined && config.rejected === undefined) {
    throw new Error("notice must configure at least one of synced or rejected");
  }
  const ttlMs = config.ttlMs;
  const enqueue = (
    resolver: NoticeResolver<Row> | undefined,
    tone: NoticeInput["tone"],
  ) =>
  (row: EffectRow<{ id: string }>, context: EffectContext) => {
    if (resolver === undefined) return;
    const runtime = requireMutationRuntime();
    runtime.enqueueNotice?.(
      { message: resolveNotice(resolver, row as EffectRow<Row>), tone, ttlMs: ttlMs ?? null },
      context,
    );
  };
  return tablelessEffect(anonymousEffectName("notice"), {
    onSynced: enqueue(config.synced, "success"),
    onRejected: enqueue(config.rejected, "error"),
  }) as EffectUnit<Row>;
}

/** Per-fate row patches for {@link mark}. */
export type MarkConfig<Init> = {
  /** The patch applied to the row when the write syncs. */
  synced?: Partial<Init>;
  /** The patch applied to the row when the write is rejected. */
  rejected?: Partial<Init>;
};

/**
 * Data-internal unit: patches the written row when its fate resolves, so write
 * fate becomes replicated data every device and query sees — the hand-rolled
 * `status` column made declarative. The patch is absolute (a static
 * set-column-to-value object), so it is convergent under re-delivery: applying
 * it twice lands the same row.
 *
 * A rejected *insert* has no row to mark — the engine rolled it out — so the
 * rejected patch is skipped for inserts; on updates and removes the row
 * survives the rollback and the patch records the failure.
 *
 * @example
 * ```ts
 * export const submit = s.mutation("submit", s.update(app.claims), {
 *   effects: [s.mark(app.claims, {
 *     synced: { status: "confirmed" },
 *     rejected: { status: "failed" },
 *   })],
 * });
 * ```
 */
export function mark<T extends { id: string }, Init>(
  table: TableProxy<T, Init>,
  config: MarkConfig<Init>,
): EffectUnit<T> {
  if (config.synced === undefined && config.rejected === undefined) {
    throw new Error("mark must configure at least one of synced or rejected");
  }
  const apply = async (
    patch: Partial<Init> | undefined,
    row: EffectRow<T>,
    skipForInsertOp: boolean,
    context: EffectContext,
  ) => {
    if (patch === undefined) return;
    // A rejected insert left no row behind; patching a vanished id would only
    // fail the obligation into a pointless retry.
    if (skipForInsertOp && context.op === "insert") return;
    await requireMutationRuntime().applyMark?.(
      table as TableProxy<unknown, unknown>,
      row.id,
      patch as Record<string, unknown>,
    );
  };
  return effect(anonymousEffectName("mark"), table, {
    onSynced: (row, context) => apply(config.synced, row, false, context),
    onRejected: (row, context) => apply(config.rejected, row, true, context),
  });
}

/**
 * Data-internal unit: issues a follow-up verb once the write syncs, mapping
 * the settled row to the next verb's input. Reifies a chain of writes
 * (reserve → charge → fulfill) declaratively, without a saga API — each link
 * is an ordinary verb, so its own effects and rejection handling apply. Fires
 * only on `synced`; a rejected write starts no chain.
 *
 * The follow-up is itself journaled and idempotent by its own write id. This
 * unit's obligation is marked delivered once the next verb is durably saved,
 * so a crash between links re-issues from the last settled row.
 *
 * @example
 * ```ts
 * export const reserve = s.mutation("reserve", s.insert(app.holds), {
 *   effects: [s.chain(charge, (hold) => ({ holdId: hold.id, amount: hold.total }))],
 * });
 * ```
 */
export function chain<Row extends { id: string }, NextInput>(
  next: (input: NextInput) => WriteHandle<unknown>,
  toInput: (row: EffectRow<Row>) => NextInput,
): EffectUnit<Row> {
  return tablelessEffect(anonymousEffectName("chain"), {
    onSynced: async (row) => {
      // Await local durability of the follow-up: only then is this link safe
      // to mark delivered, so a crash re-issues rather than dropping it.
      await next(toInput(row as EffectRow<Row>)).saved;
    },
  }) as EffectUnit<Row>;
}

/** Options for the {@link webhook} unit. */
export type WebhookOptions = {
  /** Which fates POST; defaults to both. */
  on?: ReadonlyArray<"synced" | "rejected">;
  /**
   * Delivery window in milliseconds. Receiver idempotency windows are finite
   * (Stripe forgets keys after ~24h), so external delivery defaults to a
   * conservative 24 hours rather than infinity; pass `null` to opt into no
   * expiry.
   *
   * @default 86_400_000
   */
  expiresAfterMs?: number | null;
  /** Failing attempts before the obligation is quarantined. */
  maxAttempts?: number;
  /** Extra headers merged onto the POST (the idempotency key is always set). */
  headers?: Record<string, string>;
};

const defaultWebhookExpiry = 24 * 60 * 60 * 1000;

/**
 * External unit: POSTs the settled row and its fate to `url`, with the
 * obligation's journal id auto-injected as `Idempotency-Key` so a re-delivery
 * the receiver already saw is dropped receiver-side. The generic
 * outside-world workhorse and the reference for the at-least-once contract.
 *
 * Failure severity follows the response: a transient failure (network error,
 * `5xx`, `429`) throws an ordinary error, so the ledger's bounded backoff
 * retries it; a `4xx` (other than `429`) throws {@link PermanentEffectError},
 * retiring the obligation without burning the retry budget on a request the
 * receiver will keep refusing. Because receiver keys expire, delivery defaults
 * to a 24-hour window ({@link WebhookOptions.expiresAfterMs}).
 *
 * @example
 * ```ts
 * export const order = s.mutation("order", s.insert(app.orders), {
 *   effects: [s.webhook("https://hooks.example.com/orders")],
 * });
 * ```
 */
export function webhook(url: string, options: WebhookOptions = {}): EffectUnit<{ id: string }> {
  if (!url.trim()) throw new Error("webhook url must not be empty");
  const fates = new Set(options.on ?? ["synced", "rejected"]);
  const post = async (row: EffectRow<{ id: string }>, context: EffectContext) => {
    if (!fates.has(context.fate)) return;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": context.journalId,
          ...options.headers,
        },
        body: JSON.stringify({
          journalId: context.journalId,
          verb: context.verb,
          table: context.table,
          op: context.op,
          fate: context.fate,
          code: context.code,
          reason: context.reason,
          row,
        }),
      });
    } catch (error) {
      // A network-level failure is transient by nature: rethrow so the ledger
      // retries with backoff inside the delivery window.
      throw new Error(`webhook ${url} unreachable: ${(error as Error).message}`);
    }
    if (response.ok) return;
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new PermanentEffectError(`webhook ${url} refused with ${response.status}`);
    }
    throw new Error(`webhook ${url} transient failure ${response.status}`);
  };
  return tablelessEffect("webhook:" + url, { onSynced: post, onRejected: post }, {
    expiresAfterMs: options.expiresAfterMs === undefined
      ? defaultWebhookExpiry
      : options.expiresAfterMs ?? undefined,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });
}
