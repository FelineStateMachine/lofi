import { assert, assertCount } from "./test-assert.ts";
import { WriteHandle, WriteRejectedError } from "./write-handle.ts";

Deno.test("await resolves at saved with the write's value", async () => {
  const handle = new WriteHandle<{ id: string }>("w1");
  handle.advance("saved", { id: "row-1" });
  const row = await handle;
  assert(row.id === "row-1", "the thenable must resolve with the saved value");
  assert(handle.stage === "saved", "stage must be saved after local durability");
});

Deno.test("stages are monotonic and never regress", () => {
  const handle = new WriteHandle<void>("w1");
  handle.advance("synced");
  handle.advance("saved");
  assert(handle.stage === "synced", "a later stage must not regress to an earlier one");
  handle.reject({ cause: "denied", code: "permission_denied", reason: "late" });
  assert(handle.stage === "synced", "a settled write must ignore late verdicts");
  assert(handle.reason === null, "a settled write must not carry a rejection");
});

Deno.test("synced resolves with the value staged before confirmation", async () => {
  const handle = new WriteHandle<{ id: string }>("w1");
  handle.advance("saving", { id: "row-9" });
  handle.advance("synced");
  const row = await handle.synced;
  assert(row.id === "row-9", "synced must resolve with the staged value");
});

Deno.test("rejection settles both promises with WriteRejectedError and sets reason", async () => {
  const handle = new WriteHandle<void>("w1");
  handle.advance("saved");
  handle.reject({ cause: "denied", code: "permission_denied", reason: "denied by store" });
  assert(handle.stage === "rejected", "the verdict must reach the stage");
  assert(handle.reason?.code === "permission_denied", "the rejection code must be readable");
  const error = await handle.synced.then(() => null, (thrown) => thrown as WriteRejectedError);
  assert(error instanceof WriteRejectedError, "synced must reject with WriteRejectedError");
  assert(error.writeId === "w1", "the error must carry the journal id");
});

Deno.test("an unobserved rejected handle leaks no unhandled rejection", async () => {
  const handle = new WriteHandle<void>("w1");
  handle.reject({ cause: "denied", code: null, reason: "refused" });
  // Nothing awaits the handle; settling the microtask queue must not surface
  // an unhandled rejection (the test runner fails the test if one escapes).
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(handle.stage === "rejected", "the refusal must still settle the stage");
});

Deno.test("subscribers are level-triggered: late subscribers see current truth", () => {
  const handle = new WriteHandle<void>("w1");
  handle.advance("saved");
  const seen: string[] = [];
  const stop = handle.subscribe(() => seen.push(handle.stage));
  assert(seen[0] === "saved", "a late subscriber must immediately observe the current stage");
  handle.advance("synced");
  assert(seen[1] === "synced", "subscribers must observe later transitions");
  stop();
  stop();
  handle.reject({ cause: "denied", code: null, reason: "ignored" });
  assertCount(seen.length, 2, "an unsubscribed listener must not be notified");
});
