// Compile-time contract of encrypted columns, pinned with @ts-expect-error:
// filter positions collapse to `never`, chaining modifiers are disabled, and
// row/insert view types survive. This suite is the canary for the branding
// mechanism — it relies on the engine's where-input mapping being
// non-distributive over the stored sql type, so an engine bump that changes
// that shape fails here first.
import { type EncryptedColumn, s } from "./mod.ts";
import { clearEncryptedColumnRegistry } from "./encrypted.ts";
import { assert } from "../runtime/test-assert.ts";

const app = s.defineApp({
  notes: s.table({
    title: s.string(),
    body: s.encryptedText("types.notes.body"),
    amount: s.encryptedNumber("types.notes.amount"),
    reviewedAt: s.encryptedDate("types.notes.reviewedAt"),
    meta: s.encryptedJson<{ tag: string }>("types.notes.meta"),
  }),
});
clearEncryptedColumnRegistry();

Deno.test("encrypted columns are excluded from where at compile time", () => {
  // Plaintext columns filter as before.
  const plaintextQuery = app.notes.where({ title: "x" });
  assert(plaintextQuery !== undefined, "plaintext where must remain expressible");

  // @ts-expect-error — a where on an encrypted text column does not compile
  app.notes.where({ body: "x" });
  // @ts-expect-error — a where on an encrypted number column does not compile
  app.notes.where({ amount: 1 });
  // @ts-expect-error — a where on an encrypted date column does not compile
  app.notes.where({ reviewedAt: new Date(0) });
  // @ts-expect-error — a where on an encrypted json column does not compile
  app.notes.where({ meta: { tag: "x" } });
  // @ts-expect-error — operator objects are equally rejected
  app.notes.where({ body: { contains: "x" } });
});

Deno.test("encrypted columns reject chaining modifiers at compile time", () => {
  const column = s.encryptedText("types.chain.column");
  // @ts-expect-error — a default would be applied below the seal boundary
  column.default("x");
  // @ts-expect-error — merge strategies cannot operate on ciphertext
  column.merge("lww");
  // @ts-expect-error — a transform would replace the seal itself
  column.transform({ from: (v: string) => v, to: (v: string) => v });
  // @ts-expect-error — optional stays disabled until null handling is pinned
  column.optional();
  clearEncryptedColumnRegistry();
});

Deno.test("view types survive the brand", () => {
  // The view type parameter is what row and insert types read.
  const text: EncryptedColumn<string> = s.encryptedText("types.view.text");
  const amount: EncryptedColumn<number> = s.encryptedNumber("types.view.amount");
  const at: EncryptedColumn<Date> = s.encryptedDate("types.view.at");
  const json: EncryptedColumn<{ n: number }> = s.encryptedJson<{ n: number }>("types.view.json");
  assert(
    [text, amount, at, json].every((column) => typeof column === "object"),
    "factories must return live builders",
  );
  clearEncryptedColumnRegistry();
});
