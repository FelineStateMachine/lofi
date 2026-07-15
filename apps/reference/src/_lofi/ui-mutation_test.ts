import { settleUiMutation } from "./ui-mutation.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

test("UI mutation boundary handles a rejection after runtime state projection", async () => {
  await settleUiMutation(Promise.reject(new Error("durable write failed")));
});
