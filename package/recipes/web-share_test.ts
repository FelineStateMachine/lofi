import { parseTextShareTarget, shareOrFallback, type WebShareClient } from "./web-share.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("share recipe uses native share only for a supported user-triggered payload", async () => {
  const calls: string[] = [];
  const client: WebShareClient = {
    canShare: (data) => {
      calls.push(`can:${data.title}`);
      return true;
    },
    share: (data) => {
      calls.push(`share:${data.title}`);
      return Promise.resolve();
    },
  };
  const outcome = await shareOrFallback({ title: "One task" }, {
    client,
    fallback: () => {
      calls.push("fallback");
    },
  });
  assert(outcome === "shared", `native share ended in ${outcome}`);
  assert(calls.join(",") === "can:One task,share:One task", "native share order drifted");
});

Deno.test("share recipe falls back only when native sharing is unavailable", async () => {
  let fallbackCount = 0;
  const unavailable = await shareOrFallback({ text: "Task" }, {
    client: {},
    fallback: () => {
      fallbackCount++;
    },
  });
  const rejected = await shareOrFallback({ text: "Task" }, {
    client: { canShare: () => false, share: () => Promise.resolve() },
    fallback: () => {
      fallbackCount++;
    },
  });
  assert(unavailable === "fallback" && rejected === "fallback", "fallback state was not stable");
  assert(fallbackCount === 2, `expected two fallback calls, received ${fallbackCount}`);
});

Deno.test("share recipe distinguishes cancellation from runtime failure", async () => {
  let fallbackCalled = false;
  const cancelled = await shareOrFallback({ text: "Task" }, {
    client: { share: () => Promise.reject(new DOMException("closed", "AbortError")) },
    fallback: () => {
      fallbackCalled = true;
    },
  });
  const failed = await shareOrFallback({ text: "Task" }, {
    client: { share: () => Promise.reject(new Error("browser failure")) },
    fallback: () => {
      fallbackCalled = true;
    },
  });
  assert(cancelled === "cancelled", `cancellation ended in ${cancelled}`);
  assert(failed === "failed", `runtime failure ended in ${failed}`);
  assert(!fallbackCalled, "native sheet failure unexpectedly copied shared data");
});

Deno.test("text share target accepts bounded title, text, and HTTP URLs", () => {
  const result = parseTextShareTarget(
    "?title=One+task&text=Review+it&url=https%3A%2F%2Fexample.com%2Fnotes&ignored=1",
  );
  assert(result.ok, `valid share was rejected: ${JSON.stringify(result)}`);
  assert(result.draft.title === "One task", "share title was not decoded");
  assert(result.draft.text === "Review it", "share text was not decoded");
  assert(result.draft.url === "https://example.com/notes", "share URL was not normalized");
  assert(!("ignored" in result.draft), "unknown input reached the draft");
});

Deno.test("text share target rejects duplicate, oversized, malformed, and dangerous input", () => {
  const duplicate = parseTextShareTarget("?title=one&title=two");
  assert(!duplicate.ok && duplicate.issues.includes("duplicate-title"), "duplicate title passed");

  const oversized = parseTextShareTarget(`?text=${"x".repeat(2_001)}`);
  assert(!oversized.ok && oversized.issues.includes("text-too-long"), "oversized text passed");

  const malformed = parseTextShareTarget("?url=not-a-url");
  assert(!malformed.ok && malformed.issues.includes("invalid-url"), "malformed URL passed");

  const dangerous = parseTextShareTarget("?url=javascript%3Aalert(1)");
  assert(
    !dangerous.ok && dangerous.issues.includes("unsupported-url-protocol"),
    "dangerous URL protocol passed",
  );

  const empty = parseTextShareTarget("?unknown=value");
  assert(!empty.ok && empty.issues.includes("empty-share"), "empty share passed");
});
