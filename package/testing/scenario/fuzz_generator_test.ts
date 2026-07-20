// The fuzz generator is pure: these tests pin seed determinism and the
// structural invariants the executor relies on, without booting a server.
import { assert } from "../../runtime/test-assert.ts";
import { type FuzzColumn, type FuzzPlanInput, generateFuzzPlan } from "./fuzz.ts";

const columns: readonly FuzzColumn[] = [
  { name: "id", type: "Uuid", nullable: false, hasDefault: true },
  { name: "title", type: "Text", nullable: false, hasDefault: false },
  { name: "done", type: "Boolean", nullable: false, hasDefault: true },
];

const input: FuzzPlanInput = {
  seed: 42,
  steps: 60,
  peers: ["alice", "bob"],
  tables: { documents: columns },
};

Deno.test("same seed yields an identical plan", () => {
  const first = generateFuzzPlan(input);
  const second = generateFuzzPlan(input);
  assert(
    JSON.stringify(first) === JSON.stringify(second),
    "two runs of the generator with one seed diverged",
  );
  assert(first.ops.length > 0, "the plan generated no operations");
});

Deno.test("plans keep their structural invariants", () => {
  for (const seed of [1, 7, 99, 12345]) {
    const plan = generateFuzzPlan({ ...input, seed });
    const insertsByRef = new Map<number, { table: string; peer: string }>();
    const barrierKnown = new Set<number>();
    const offline = new Set<string>();
    for (const op of plan.ops) {
      if (op.kind === "insert") {
        insertsByRef.set(op.ref, { table: op.table, peer: op.peer });
      } else if (op.kind === "update" || op.kind === "remove") {
        const origin = insertsByRef.get(op.ref);
        assert(origin !== undefined, `seed ${seed}: op targets ref ${op.ref} before its insert`);
        assert(origin.table === op.table, `seed ${seed}: op targets ref ${op.ref} across tables`);
        assert(
          origin.peer === op.peer || barrierKnown.has(op.ref),
          `seed ${seed}: ${op.peer} targets a row it cannot have observed`,
        );
      } else if (op.kind === "offline") {
        assert(!offline.has(op.peer), `seed ${seed}: ${op.peer} went offline twice`);
        offline.add(op.peer);
      } else if (op.kind === "online") {
        assert(offline.has(op.peer), `seed ${seed}: ${op.peer} came online while online`);
        offline.delete(op.peer);
      } else {
        assert(offline.size === 0, `seed ${seed}: sync barrier while a peer is offline`);
        for (const ref of insertsByRef.keys()) barrierKnown.add(ref);
      }
    }
    assert(offline.size === 0, `seed ${seed}: the plan ends with a peer offline`);
  }
});

Deno.test("tables the generator cannot insert into are skipped", () => {
  const plan = generateFuzzPlan({
    ...input,
    tables: {
      documents: columns,
      attachments: [
        { name: "id", type: "Uuid", nullable: false, hasDefault: true },
        {
          name: "document",
          type: "Uuid",
          nullable: false,
          hasDefault: false,
          references: "documents",
        },
      ],
    },
  });
  assert(
    plan.skippedTables.length === 1 && plan.skippedTables[0] === "attachments",
    "a required foreign-key table was not skipped",
  );
  assert(
    plan.ops.every((op) =>
      op.kind === "offline" || op.kind === "online" || op.kind === "sync" ||
      op.table === "documents"
    ),
    "an op targeted a skipped table",
  );
});
