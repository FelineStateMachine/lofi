import { schema } from "jazz-tools";
import { assert, assertCount } from "../runtime/test-assert.ts";
import type { WriteHandle } from "../runtime/write-handle.ts";
import { chain, mark, notice, trace, webhook } from "./effect-library.ts";
import {
  clearEffectDeclarations,
  effect,
  type EffectContext,
  insert,
  mutation,
  type MutationRuntime,
  type NoticeInput,
  resolveEffectUnit,
  setMutationRuntime,
} from "./effects.ts";

const app = schema.defineApp({
  claims: schema.table({ title: schema.string(), status: schema.string() }),
});
type Claim = schema.RowOf<typeof app.claims>;

type Recorder = {
  traces: Array<{ label: string | null; context: EffectContext }>;
  notices: Array<{ input: NoticeInput; context: EffectContext }>;
  marks: Array<{ rowId: string; patch: Record<string, unknown> }>;
  dispatched: Array<{
    descriptor: unknown;
    args: readonly unknown[];
    parentJournalId?: string;
  }>;
};

function install(): Recorder {
  const recorder: Recorder = { traces: [], notices: [], marks: [], dispatched: [] };
  const runtime: MutationRuntime = {
    dispatch(descriptor, args) {
      recorder.dispatched.push({ descriptor, args });
      return { saved: Promise.resolve() } as unknown as WriteHandle<unknown>;
    },
    dispatchChained(descriptor, args, parentJournalId) {
      recorder.dispatched.push({ descriptor, args, parentJournalId });
      return Promise.resolve();
    },
    recordLog() {},
    recordTrace(label, context) {
      recorder.traces.push({ label, context });
    },
    enqueueNotice(input, context) {
      recorder.notices.push({ input, context });
      return Promise.resolve();
    },
    applyMark(_table, rowId, patch) {
      recorder.marks.push({ rowId, patch });
      return Promise.resolve();
    },
  };
  setMutationRuntime(runtime);
  return recorder;
}

function context(overrides: Partial<EffectContext> = {}): EffectContext {
  return {
    journalId: "w1:unit#1",
    writeId: "w1",
    verb: "submit",
    table: "claims",
    op: "update",
    rowId: "row-1",
    writeCreatedAt: 500,
    fate: "synced",
    cause: null,
    code: null,
    reason: null,
    ...overrides,
  };
}

// The identity guarantee: an anonymous built-in takes its durable name from
// the verb it is attached to and its position in that verb's effects, NOT from
// a global declaration counter. This is what makes a journaled notice/mark/
// chain obligation re-arm against the same logical unit regardless of which
// module evaluated first on the re-arming boot.
Deno.test("anonymous units are named <verb>#<index>, stable and verb-scoped", () => {
  clearEffectDeclarations();
  install();
  const orders = schema.defineApp({ orders: schema.table({ item: schema.string() }) }).orders;
  mutation("placeOrder", insert(orders), {
    effects: [notice({ synced: "Placed." }), mark(orders, { synced: { item: "x" } })],
  });
  mutation("reorder", insert(orders), {
    effects: [notice({ synced: "Reordered." })],
  });
  // Position within the verb, not a global counter: reorder's notice is #0,
  // not #2, so adding placeOrder above it cannot shift reorder's identity.
  assert(resolveEffectUnit("placeOrder#0") !== null, "the first unit is <verb>#0");
  assert(resolveEffectUnit("placeOrder#1") !== null, "the second unit is <verb>#1");
  assert(resolveEffectUnit("reorder#0") !== null, "a second verb restarts the index at 0");
  assert(resolveEffectUnit("reorder#1") === null, "reorder declares only one anonymous unit");
  clearEffectDeclarations();
});

Deno.test("trace records a span with the saved-to-fate latency on either fate", () => {
  clearEffectDeclarations();
  const recorder = install();
  const unit = trace("checkout");
  unit.handlers.onSynced?.({ id: "row-1" }, context({ writeCreatedAt: 500 }));
  unit.handlers.onRejected?.({ id: "row-1" }, context({ fate: "rejected" }));
  assertCount(recorder.traces.length, 2, "both fates must record a span");
  assert(recorder.traces[0].label === "checkout", "the span must carry the author label");
  clearEffectDeclarations();
});

// The content-named built-ins share one unit per identity instead of throwing
// a duplicate-name error when reused across verbs.
Deno.test("trace and webhook share one unit per durable identity", () => {
  clearEffectDeclarations();
  install();
  assert(trace("checkout") === trace("checkout"), "one label shares one trace unit");
  assert(trace() === trace(), "the unlabeled trace shares one unit");
  const url = "https://hooks.example.com/x";
  assert(webhook("orders", url) === webhook("orders", url), "one name+config shares one unit");
  let mismatched = false;
  try {
    webhook("orders", url, { maxAttempts: 9 });
  } catch (error) {
    mismatched = !(error as Error).message.includes(url);
  }
  assert(mismatched, "reusing a name with different config must fail without leaking config");
  assert(
    webhook("orders-v2", url, { maxAttempts: 9 }) !== webhook("orders", url),
    "a distinct author name creates a distinct durable unit",
  );
  clearEffectDeclarations();
});

Deno.test("notice enqueues a message keyed by the obligation journal id", async () => {
  clearEffectDeclarations();
  const recorder = install();
  const unit = notice<Claim>({
    synced: "Submitted.",
    rejected: (claim) => `Could not submit "${claim.title ?? "claim"}".`,
  });
  await unit.handlers.onSynced?.({ id: "row-1" }, context({ journalId: "w1:notice#1" }));
  await unit.handlers.onRejected?.(
    { id: "row-1", title: "roof" } as Claim & { id: string },
    context({ fate: "rejected", journalId: "w2:notice#1" }),
  );
  assertCount(recorder.notices.length, 2, "each fate with a message enqueues one notice");
  assert(
    recorder.notices[0].input.message === "Submitted.",
    "the static message must pass through",
  );
  assert(recorder.notices[0].input.tone === "success", "a synced notice is a success tone");
  assert(
    recorder.notices[1].input.message === 'Could not submit "roof".',
    "the resolver must see the settled row",
  );
  assert(recorder.notices[1].input.tone === "error", "a rejected notice is an error tone");
  clearEffectDeclarations();
});

Deno.test("notice fires only the configured fate", async () => {
  clearEffectDeclarations();
  const recorder = install();
  const unit = notice({ rejected: "Failed." });
  await unit.handlers.onSynced?.({ id: "row-1" }, context());
  assertCount(recorder.notices.length, 0, "an unconfigured synced fate enqueues nothing");
  await unit.handlers.onRejected?.({ id: "row-1" }, context({ fate: "rejected" }));
  assertCount(recorder.notices.length, 1, "the configured rejected fate enqueues");
  clearEffectDeclarations();
});

Deno.test("mark patches the row on synced and on a rejected update", async () => {
  clearEffectDeclarations();
  const recorder = install();
  const unit = mark(app.claims, {
    synced: { status: "confirmed" },
    rejected: { status: "failed" },
  });
  await unit.handlers.onSynced?.({ id: "row-1" }, context({ op: "update" }));
  await unit.handlers.onRejected?.({ id: "row-1" }, context({ op: "update", fate: "rejected" }));
  assertCount(recorder.marks.length, 2, "both fates patch the surviving row");
  assert(recorder.marks[0].patch.status === "confirmed", "synced must apply its patch");
  assert(recorder.marks[1].patch.status === "failed", "a rejected update must apply its patch");
  clearEffectDeclarations();
});

Deno.test("mark skips a rejected insert, which left no row to patch", async () => {
  clearEffectDeclarations();
  const recorder = install();
  const unit = mark(app.claims, { rejected: { status: "failed" } });
  await unit.handlers.onRejected?.({ id: "row-1" }, context({ op: "insert", fate: "rejected" }));
  assertCount(recorder.marks.length, 0, "a rolled-back insert has no row, so mark must skip it");
  clearEffectDeclarations();
});

Deno.test("chain issues the follow-up verb only on synced", async () => {
  clearEffectDeclarations();
  const recorder = install();
  const charge = mutation("chargeClaim", insert(app.claims));
  const unit = chain(charge, (row: { id: string }) => ({
    title: row.id,
    status: "charging",
  }));
  await unit.handlers.onRejected?.({ id: "row-1" }, context({ fate: "rejected" }));
  assertCount(recorder.dispatched.length, 0, "a rejected write starts no chain");
  await unit.handlers.onSynced?.({ id: "row-1" }, context());
  assertCount(recorder.dispatched.length, 1, "a synced write issues the follow-up verb once");
  assert(
    (recorder.dispatched[0].args[0] as { title: string }).title === "row-1",
    "the mapper must receive the settled row",
  );
  assert(
    recorder.dispatched[0].parentJournalId === "w1:unit#1",
    "the child must be tied to its parent obligation identity",
  );
  clearEffectDeclarations();
});

Deno.test("webhook injects the journal id as the idempotency key and posts the fate", async () => {
  clearEffectDeclarations();
  install();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch;
  try {
    const unit = webhook("claims", "https://hooks.example.com/claims", {
      headers: { authorization: "secret", "idempotency-key": "override" },
    });
    assert(unit.effectName === "webhook:claims", "durable identity must contain only the name");
    assert(!unit.effectName.includes("secret"), "header secrets must not enter durable identity");
    await unit.handlers.onSynced?.({ id: "row-1" }, context({ journalId: "w1:webhook#1" }));
    assertCount(requests.length, 1, "a synced write posts once");
    const key = new Headers(requests[0].init.headers as HeadersInit).get("idempotency-key") ?? "";
    assert(key === "w1:webhook#1", "the journal id must ride as the idempotency key");
    const body = JSON.parse(String(requests[0].init.body));
    assert(body.fate === "synced", "the payload must carry the settled fate");
  } finally {
    globalThis.fetch = originalFetch;
  }
  clearEffectDeclarations();
});

Deno.test("webhook treats a 4xx as permanent and a 5xx as retryable", async () => {
  clearEffectDeclarations();
  install();
  const originalFetch = globalThis.fetch;
  const respond = (status: number) => {
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status }))) as typeof fetch;
  };
  try {
    const unit = webhook("claims", "https://hooks.example.com/claims");
    respond(400);
    let permanent = false;
    try {
      await unit.handlers.onSynced?.({ id: "row-1" }, context());
    } catch (error) {
      permanent = (error as Error).name === "PermanentEffectError";
    }
    assert(permanent, "a 4xx must throw a PermanentEffectError so the ledger retires it");

    respond(503);
    let retryable = false;
    try {
      await unit.handlers.onSynced?.({ id: "row-1" }, context());
    } catch (error) {
      retryable = (error as Error).name !== "PermanentEffectError";
    }
    assert(retryable, "a 5xx must throw an ordinary error so the ledger retries it");
  } finally {
    globalThis.fetch = originalFetch;
  }
  clearEffectDeclarations();
});

// The contract's proof: a custom unit written with nothing but the public
// authoring surface — s.effect, the context's journal id as the idempotency
// key, and PermanentEffectError for a hopeless failure — behaves like a
// built-in. This is also the authoring guide's worked example.
Deno.test("a custom unit on the public contract is idempotent by journal id", async () => {
  clearEffectDeclarations();
  install();
  const seen = new Set<string>();
  let sends = 0;
  const sendOnce = effect("sendReceipt", app.claims, {
    onSynced: (_row, context) => {
      // The at-least-once duty: dedupe on the journal id so a re-delivered
      // handler produces one external effect.
      if (seen.has(context.journalId)) return;
      seen.add(context.journalId);
      sends += 1;
    },
  });
  await sendOnce.handlers.onSynced?.({ id: "row-1" }, context({ journalId: "w1:sendReceipt" }));
  await sendOnce.handlers.onSynced?.({ id: "row-1" }, context({ journalId: "w1:sendReceipt" }));
  assertCount(sends, 1, "a re-delivery under one journal id must produce one effect");
  clearEffectDeclarations();
});

Deno.test("webhook defaults to a finite 24-hour delivery window", () => {
  clearEffectDeclarations();
  install();
  const unit = webhook("claims", "https://hooks.example.com/claims");
  assert(unit.expiresAfterMs === 24 * 60 * 60 * 1000, "external delivery must default to 24h");
  const forever = webhook("claims-forever", "https://hooks.example.com/claims2", {
    expiresAfterMs: null,
  });
  assert(
    forever.expiresAfterMs === null || forever.expiresAfterMs === undefined,
    "null must opt into no expiry",
  );
  clearEffectDeclarations();
});

Deno.test("webhook default expiry and explicit no-expiry do not alias", () => {
  clearEffectDeclarations();
  install();
  const url = "https://hooks.example.com/expiry";
  webhook("expiry", url);
  let thrown = false;
  try {
    webhook("expiry", url, { expiresAfterMs: null });
  } catch {
    thrown = true;
  }
  assert(thrown, "explicit null must not reuse the default 24-hour configuration");
  clearEffectDeclarations();
});
