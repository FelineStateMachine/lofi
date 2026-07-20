# The effect library

Effect units give a verb consequences: a handler that runs on the originating device when the
write's fate settles. [Nouns and verbs](nouns-and-verbs.md) covers the machinery — declaration, the
journal, at-least-once delivery, retention. This page is the built-in library and the contract for
authoring your own.

The teaching path runs one new idea at a time: declare a verb, **observe** it (`s.log`, `s.trace`),
make its fate **data** (`s.notice`, `s.mark`), **compose** further writes (`s.chain`), then reach
the **outside world** (`s.webhook`). Every built-in is idempotent by construction, so each is also a
worked example of the discipline your own units must follow.

## The authoring contract

A custom unit is `s.effect(name, table, handlers, options)`. Four rules make it safe:

- **The name is a durable identity.** The journal re-arms a unit's handlers by name after a reload,
  so names are app-unique (a duplicate throws at declaration) and renaming a unit orphans its
  in-flight obligations. The anonymous built-ins (`s.notice`, `s.mark`, `s.chain`) take their
  identity from declaration order instead; reordering the verbs that declare them has the same
  orphaning effect as a rename.
- **Delivery is at-least-once, so handlers must be idempotent.** A crash between handler start and
  journal completion re-runs the handler at the next boot. The `context.journalId` a handler
  receives — the write's `(write id, effect name)` key — is the idempotency key: pass it to any
  external call, and dedupe your own side effects on it.
- **Failure has two severities.** An ordinary thrown error is _retryable_: the obligation re-arms at
  the next boot until it succeeds or `maxAttempts` (default 5) quarantines it. Throwing
  `PermanentEffectError` is _permanent_: the obligation retires immediately, without burning the
  retry budget on a call that will keep failing. Both are counted in runtime diagnostics; a failed
  handler is never silently swallowed.
- **`onRejected` compensates ancillary state, never row data.** The engine rolls a rejected write
  out of local query results itself. After a reload a rejected handler receives the row id alone, so
  compensate what the user was told or what you called externally — not the row.

A unit written to these rules behaves like a built-in. This is the smallest one:

```ts
import { PermanentEffectError, s } from "@nzip/lofi/schema";

const sent = new Set<string>();
export const sendReceipt = s.effect("sendReceipt", app.schema.orders, {
  onSynced: async (order, { journalId }) => {
    if (sent.has(journalId)) return; // at-least-once: dedupe on the key
    const res = await fetch(receiptUrl, { headers: { "Idempotency-Key": journalId } });
    if (res.status >= 400 && res.status < 500) {
      throw new PermanentEffectError(`receipt refused: ${res.status}`); // do not retry
    }
    if (!res.ok) throw new Error(`receipt transient failure: ${res.status}`); // retry
    sent.add(journalId);
  },
});
```

## Observation tier

Cannot change anything — they only record.

### `s.log(label)`

Records a structured diagnostics entry (write id, fate, timing) on either fate. Repeated calls with
one label share a unit. See [nouns and verbs](nouns-and-verbs.md#effect-units).

### `s.trace(label?)`

A span from the write's journaling to its settled fate, recorded in runtime diagnostics as an
OpenTelemetry-shaped event with the saved→synced/rejected latency. Pure instrumentation and the
observability hook; an OTLP exporter is an adapter over this feed, never a concept you configure per
verb. Without a label the verb name labels the span.

```ts
export const placeOrder = s.mutation("placeOrder", s.insert(app.schema.orders), {
  effects: [s.trace("checkout")],
});
```

### `s.debug()`

A development-only timeline of each fate an obligation settles, for eyeballing delivery in the
inspector. Stripped from production builds — in a `PROD` bundle the handlers record nothing.

## Data-internal tier

Write back into the app. Fate stops being a callback and becomes replicated data.

### `s.notice(config)`

Enqueues a durable, user-visible message when the write settles — the fix for the "a rejected write
still flashed success" failure mode. The queue is durable and UI-agnostic: an entry created at a
boot re-arm survives with nothing mounted, and a component renders it later. Render with the
built-in `<Notices />` or the `useNotices()` hook from `@nzip/lofi/preact`; a toast stack is a
userland wrapper over the same queue, never an imperative call. Idempotent by the obligation's
journal id, so a re-delivery enqueues one entry. `ttlMs` bounds an entry's life; pass `null` to keep
it until dismissed.

```ts
export const publish = s.mutation("publish", s.update(app.schema.posts), {
  effects: [s.notice<Post>({
    synced: "Published.",
    rejected: (post) => `Could not publish "${post.title}".`,
  })],
});
```

### `s.mark(table, config)`

Patches the written row when its fate resolves, so write fate becomes replicated data every device
and query sees — the hand-rolled `status` column made declarative. The patch is absolute (a static
set-column-to-value object), so it is convergent under re-delivery. A rejected _insert_ has no row
to mark — the engine rolled it out — so the rejected patch is skipped for inserts; on updates and
removes the row survives the rollback.

```ts
export const submit = s.mutation("submit", s.update(app.schema.claims), {
  effects: [s.mark(app.schema.claims, {
    synced: { status: "confirmed" },
    rejected: { status: "failed" },
  })],
});
```

### `s.chain(verb, toInput)`

Issues a follow-up verb once the write syncs, mapping the settled row to the next verb's input.
Reifies a chain of writes (reserve → charge → fulfill) declaratively without a saga API — each link
is an ordinary verb with its own effects and rejection handling. Fires only on `synced`.

```ts
export const reserve = s.mutation("reserve", s.insert(app.schema.holds), {
  effects: [s.chain(charge, (hold) => ({ holdId: hold.id, amount: hold.total }))],
});
```

## External tier

Where the guardrails earn their keep.

### `s.webhook(url, options?)`

POSTs the settled row and its fate to `url`, with the obligation's journal id auto-injected as
`Idempotency-Key` so a re-delivery the receiver already saw is dropped receiver-side. The generic
integration workhorse and the reference for the at-least-once contract.

- **Failure severity follows the response.** A network error, `5xx`, or `429` throws an ordinary
  error, so the ledger's bounded backoff retries it; any other `4xx` throws `PermanentEffectError`,
  retiring the obligation rather than retrying a request the receiver will keep refusing.
- **Delivery defaults to a finite window.** Receiver idempotency windows are finite (Stripe forgets
  keys after ~24h), so external delivery defaults to a 24-hour `expiresAfterMs` rather than
  infinity; pass `null` to opt into no expiry.

```ts
export const order = s.mutation("order", s.insert(app.schema.orders), {
  effects: [s.webhook("https://hooks.example.com/orders")],
});
```

Provider-specific units (email, SMS, push) are userland wrappers over `s.webhook`; the library ships
the workhorse, not the integrations.
