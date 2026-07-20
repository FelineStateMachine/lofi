// The scenario DSL against a real local Jazz server: the worked
// offline-rename-versus-remote-delete example, cross-peer visibility through
// converge, and a fixed-seed fuzz smoke run. Runs in its own task
// (test:scenario) because the server needs FFI.
import { schema as s } from "jazz-tools";
import { assertNoRow, assertRow, assertRowCount, converge, scenario } from "./testing/mod.ts";

const app = s.defineApp({
  documents: s.table({ title: s.string() }),
});
const permissions = s.definePermissions(app, ({ policy }) => {
  policy.documents.allowInsert.always();
  policy.documents.allowRead.always();
  policy.documents.allowUpdate.always();
  policy.documents.allowDelete.always();
});

scenario("offline rename versus remote delete", { app, permissions }, async ({ alice, bob }) => {
  const doc = await alice.db.documents.insert({ title: "Untitled" });
  await converge(alice, bob);
  await assertRow(bob, app.documents, doc.id, { title: "Untitled" });

  await alice.offline();
  await alice.db.documents.update(doc.id, { title: "Draft" });
  await bob.db.documents.remove(doc.id);
  await alice.online();
  await alice.settle();

  // PINNED (alpha.53): the delete wins everywhere except in the live session
  // that made the doomed rename — that replica keeps showing its own write
  // until it restarts. If the first assert fails, upstream started applying
  // remote deletes to live writers; drop the restart from this scenario.
  await assertRow(alice, app.documents, doc.id, { title: "Draft" });
  await alice.restart();

  await converge(alice, bob);
  await assertNoRow(alice, app.documents, doc.id);
  await assertNoRow(bob, app.documents, doc.id);
});

scenario("a fresh reader sees the converged state", { app, permissions }, async (ctx) => {
  const { alice, bob, addPeer } = ctx;
  await alice.db.documents.insert({ title: "one" });
  await bob.db.documents.insert({ title: "two" });
  await converge(alice, bob);

  const carol = await addPeer("carol");
  await converge(alice, bob, carol);
  await assertRowCount(carol, app.documents, 2);
});

scenario.fuzz("fuzzed edits converge", {
  app,
  permissions,
  seed: 7,
  steps: 15,
});
