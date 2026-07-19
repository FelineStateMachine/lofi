import type { Page } from "playwright";
import { ReadinessError, waitForReady } from "./readiness.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("waitForReady delegates polling and timeout to Playwright", async () => {
  let call: unknown[] | undefined;
  const page = {
    waitForFunction(...args: unknown[]) {
      call = args;
      return Promise.resolve({});
    },
  } as unknown as Page;
  const predicate = (expected: string) => document.body.dataset.ready === expected;

  await waitForReady(page, predicate, "yes", {
    description: "reference app boot",
    timeoutMs: 321,
    polling: 17,
  });

  assert(call?.[0] === predicate, "predicate was replaced");
  assert(call?.[1] === "yes", "predicate argument was replaced");
  assert(
    JSON.stringify(call?.[2]) === JSON.stringify({ polling: 17, timeout: 321 }),
    `unexpected Playwright options: ${JSON.stringify(call?.[2])}`,
  );
});

Deno.test("waitForReady accepts options in third position for argument-free predicates", async () => {
  let call: unknown[] | undefined;
  const page = {
    waitForFunction(...args: unknown[]) {
      call = args;
      return Promise.resolve({});
    },
  } as unknown as Page;
  const predicate = () => document.body.dataset.ready === "yes";

  await waitForReady(page, predicate, { timeoutMs: 42, polling: "raf" });

  assert(call?.[0] === predicate, "predicate was replaced");
  assert(call?.[1] === undefined, "an argument was invented for an argument-free predicate");
  assert(
    JSON.stringify(call?.[2]) === JSON.stringify({ polling: "raf", timeout: 42 }),
    `unexpected Playwright options: ${JSON.stringify(call?.[2])}`,
  );

  await waitForReady(page, predicate);
  assert(
    JSON.stringify(call?.[2]) === JSON.stringify({ polling: "raf", timeout: 10_000 }),
    `defaults were not applied without options: ${JSON.stringify(call?.[2])}`,
  );
});

Deno.test("waitForReady adds the app condition to timeout failures", async () => {
  const cause = new Error("playwright timeout");
  const page = {
    waitForFunction() {
      return Promise.reject(cause);
    },
  } as unknown as Page;

  try {
    await waitForReady(page, () => false, { description: "sync indicator" });
    throw new Error("expected readiness to fail");
  } catch (error) {
    assert(error instanceof ReadinessError, `unexpected error: ${error}`);
    assert(error.message.includes("sync indicator"), "condition was missing from the error");
    assert(error.cause === cause, "Playwright failure was not retained as the cause");
  }

  // The four-argument shape with an explicit undefined argument stays valid.
  try {
    await waitForReady(page, () => false, undefined, { description: "sync indicator" });
    throw new Error("expected readiness to fail");
  } catch (error) {
    assert(error instanceof ReadinessError, `unexpected error: ${error}`);
    assert(error.message.includes("sync indicator"), "condition was missing from the error");
  }
});
