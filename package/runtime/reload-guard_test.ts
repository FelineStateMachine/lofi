// Package contract tests for the framework reload budget: counting, the
// refusal threshold, the settled-boot reset, and storage-less degradation.
import {
  noteReloadAttempt,
  type ReloadCounterStorage,
  resetReloadAttempts,
} from "./reload-guard.ts";
import { anchorAppId } from "./data-sink.ts";
import { assert } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

function memoryStorage(): ReloadCounterStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

test("two consecutive reloads are allowed and the third is refused", () => {
  const storage = memoryStorage();
  const first = noteReloadAttempt(storage);
  assert(first.allowed && first.count === 1, "the first framework reload proceeds");
  const second = noteReloadAttempt(storage);
  assert(second.allowed && second.count === 2, "the second framework reload proceeds");
  const third = noteReloadAttempt(storage);
  assert(!third.allowed && third.count === 3, "an unbroken third reload is a cycle");
});

test("a settled boot resets the budget", () => {
  const storage = memoryStorage();
  noteReloadAttempt(storage);
  noteReloadAttempt(storage);
  resetReloadAttempts(storage);
  const next = noteReloadAttempt(storage);
  assert(next.allowed && next.count === 1, "the budget restarts after a settled boot");
});

test("a garbage counter value restarts the count instead of poisoning it", () => {
  const storage = memoryStorage();
  storage.setItem(`lofi:reload-count:${anchorAppId}`, "not a number");
  const attempt = noteReloadAttempt(storage);
  assert(attempt.allowed && attempt.count === 1, "garbage must count as zero prior attempts");
});

test("without session storage the budget degrades open", () => {
  const attempt = noteReloadAttempt(null);
  assert(attempt.allowed, "storage-less environments must not be blocked");
  resetReloadAttempts(null);
});
