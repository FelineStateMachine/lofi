// Child process for the g-set cross-table write canary in
// package/schema/conformance_test.ts. Runs the writes that hang in
// jazz-tools@2.0.0-alpha.53 behind short races and force-exits, because a
// hung FFI write cannot be cancelled from inside a test.
import { createPolicyTestApp } from "jazz-tools/testing";
import { s } from "../schema/mod.ts";

const expectLike = (value: unknown) => ({
  toThrow() {
    if (typeof value === "function") value();
  },
  not: {
    toThrow() {
      if (typeof value === "function") value();
    },
  },
});

const app = s.defineApp({
  parents: s.table({ name: s.string() }),
  tagged: s.table({ tags: s.array(s.string()).merge("g-set") as never }),
});
const permissions = s.definePermissions(app, ({ policy }) => {
  for (const table of [policy.parents, policy.tagged]) {
    table.allowInsert.always();
    table.allowRead.always();
    table.allowUpdate.always();
    table.allowDelete.always();
  }
});

const testApp = await createPolicyTestApp(app, permissions, expectLike);
const db = testApp.as({ user_id: "canary", claims: {}, authMode: "local-first" });

const race = (work: Promise<unknown>, label: string) =>
  Promise.race([
    work.then(() => `${label}:OK`, (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return `${label}:ERROR:${message}`;
    }),
    new Promise<string>((resolve) => setTimeout(() => resolve(`${label}:HUNG`), 8_000)),
  ]);

// Mode "sibling-first" writes a sibling table before the g-set table has
// ever been written (the shape that hangs in alpha.53). Mode "gset-first"
// seeds the g-set table, after which sibling writes succeed.
const mode = Deno.args[0] ?? "sibling-first";
if (mode === "gset-first") {
  console.log(
    await race(
      db.insert(app.tagged, { tags: ["a"] }).wait({ tier: "global" }),
      "gset-table-write",
    ),
  );
}
console.log(
  await race(
    db.insert(app.parents, { name: "w" }).wait({ tier: "global" }),
    "sibling-table-write",
  ),
);
Deno.exit(0);
