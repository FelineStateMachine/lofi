// Package contract tests for the shared durable-write settlement core.
import { createDiagnostics, type RuntimeDiagnostics } from "./diagnostics.ts";
import { settleDurableWrite } from "./durability.ts";
import { assert, assertCount } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

function harness(options: { failLocal?: boolean; deferGlobal?: boolean } = {}) {
  const diagnostics = createDiagnostics();
  let rejectGlobal!: (error: Error) => void;
  let resolveGlobal!: () => void;
  const globalWait = new Promise<void>((resolve, reject) => {
    resolveGlobal = resolve;
    rejectGlobal = reject;
  });
  const write = {
    wait: ({ tier }: { tier: "local" | "global" }) => {
      if (tier === "local") {
        return options.failLocal
          ? Promise.reject(new Error("local rejected"))
          : Promise.resolve("value");
      }
      return options.deferGlobal ? globalWait.then(() => "value") : Promise.resolve("value");
    },
  };
  const update = (apply: (diagnostics: RuntimeDiagnostics) => void) => apply(diagnostics);
  return { diagnostics, write, update, resolveGlobal, rejectGlobal };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("local-only settlement counts one wait and returns the value", async () => {
  const { diagnostics, write, update } = harness();
  const value = await settleDurableWrite(write, update, "none");
  assert(value === "value", "the local value must be returned");
  assertCount(diagnostics.localWaitCalls, 1, "one local wait must be counted");
  assertCount(diagnostics.pendingLocalWrites, 0, "no local write may stay pending");
  assertCount(diagnostics.pendingGlobalWrites, 0, "no global wait may be requested");
});

test("a local rejection settles the pending counter and counts one error", async () => {
  const { diagnostics, write, update } = harness({ failLocal: true });
  let rejected = false;
  try {
    await settleDurableWrite(write, update, "background");
  } catch {
    rejected = true;
  }
  assert(rejected, "a local rejection must reject the settlement");
  assertCount(diagnostics.pendingLocalWrites, 0, "a failed local write may not stay pending");
  assertCount(diagnostics.mutationErrors, 1, "the local rejection must be counted once");
  assertCount(diagnostics.pendingGlobalWrites, 0, "no global tier may start after local failure");
});

test("background mode resolves at local tier and contains a late global rejection", async () => {
  const { diagnostics, write, update, rejectGlobal } = harness({ deferGlobal: true });
  const outcomes: string[] = [];
  const value = await settleDurableWrite(write, update, "background", {
    onLocal: () => outcomes.push("local"),
    onGlobal: () => outcomes.push("global"),
    onGlobalError: () => outcomes.push("global-error"),
  });
  assert(value === "value", "background mode must resolve at local durability");
  assertCount(diagnostics.pendingGlobalWrites, 1, "the global wait must be tracked");
  rejectGlobal(new Error("late rejection"));
  await flush();
  assert(outcomes.join(",") === "local,global-error", "the rejection must reach its hook");
  assertCount(diagnostics.mutationErrors, 1, "the global rejection must be counted once");
  assertCount(diagnostics.pendingGlobalWrites, 0, "the settled global wait must not stay pending");
});

test("await mode resolves only after global durability and rethrows its rejection", async () => {
  const success = harness();
  const outcomes: string[] = [];
  await settleDurableWrite(success.write, success.update, "await", {
    onGlobal: () => outcomes.push("global"),
  });
  assert(outcomes.join(",") === "global", "await mode must observe global settlement");
  assertCount(success.diagnostics.pendingGlobalWrites, 0, "the global wait must settle");

  const failure = harness({ deferGlobal: true });
  const pending = settleDurableWrite(failure.write, failure.update, "await");
  failure.rejectGlobal(new Error("rejected globally"));
  let rejected = false;
  try {
    await pending;
  } catch {
    rejected = true;
  }
  assert(rejected, "await mode must reject when the global tier rejects");
  assertCount(failure.diagnostics.mutationErrors, 1, "the global rejection must be counted");
  assertCount(failure.diagnostics.pendingGlobalWrites, 0, "the rejected wait must settle");
});
