import {
  buildSchemaVersionRange,
  classifySchemaCompat,
  computeSchemaFingerprint,
  parseLocalSchemaVersion,
  parseSchemaCompatManifest,
  resolveAppWasmSchema,
  serializeLocalSchemaVersion,
} from "./compat.ts";
import { s } from "./mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const appV1 = s.defineApp({
  todos: s.table({ title: s.string(), done: s.boolean() }),
});
const appV2 = s.defineApp({
  todos: s.table({ title: s.string(), done: s.boolean(), note: s.string() }),
});

Deno.test("schema fingerprints are stable, versioned, and column-order insensitive", async () => {
  const first = await computeSchemaFingerprint(resolveAppWasmSchema(appV1));
  const again = await computeSchemaFingerprint(resolveAppWasmSchema(appV1));
  assert(first === again, "the same schema produced two fingerprints");
  assert(/^v1:[0-9a-f]{16}$/.test(first), `fingerprint is not versioned hex: ${first}`);

  const reordered = {
    todos: {
      columns: [
        { name: "title", column_type: "Text" },
        { name: "done", column_type: "Boolean" },
      ],
    },
  };
  const sorted = {
    todos: {
      columns: [
        { name: "done", column_type: "Boolean" },
        { name: "title", column_type: "Text" },
      ],
    },
  };
  assert(
    await computeSchemaFingerprint(reordered) === await computeSchemaFingerprint(sorted),
    "column order changed the fingerprint",
  );
  assert(
    first !== await computeSchemaFingerprint(resolveAppWasmSchema(appV2)),
    "two different schemas collided",
  );
  const roundTripped = JSON.parse(
    JSON.stringify(resolveAppWasmSchema(appV1)),
  ) as Record<string, unknown>;
  assert(
    first === await computeSchemaFingerprint(roundTripped),
    "a schema and its JSON snapshot fingerprint differently",
  );
});

Deno.test("nested apps fingerprint through their deploy target", async () => {
  const nested = s.defineNestedApp({
    taskapp: { tasks: s.table({ text: s.string() }) },
  });
  const fingerprint = await computeSchemaFingerprint(resolveAppWasmSchema(nested));
  assert(/^v1:[0-9a-f]{16}$/.test(fingerprint), "nested app produced no fingerprint");
});

Deno.test("a schema version range carries its head and every ancestor", async () => {
  const ancestor = resolveAppWasmSchema(appV1);
  const range = await buildSchemaVersionRange(appV2, [ancestor]);
  const ancestorFingerprint = await computeSchemaFingerprint(ancestor);
  const head = await computeSchemaFingerprint(resolveAppWasmSchema(appV2));
  assert(range.head === head, "range head is not the app's fingerprint");
  assert(range.lineage.includes(head), "range lineage omitted the head");
  assert(range.lineage.includes(ancestorFingerprint), "range lineage omitted the ancestor");
  const noAncestors = await buildSchemaVersionRange(appV1);
  assert(
    noAncestors.lineage.length === 1 && noAncestors.lineage[0] === noAncestors.head,
    "an unmigrated app's lineage is not exactly its head",
  );
});

Deno.test("gate classification covers first-boot, equal, code-ahead, data-ahead, unrelated", () => {
  const older = { head: "v1:a", lineage: ["v1:a"] };
  const newer = { head: "v1:b", lineage: ["v1:a", "v1:b"] };
  const foreign = { head: "v1:z", lineage: ["v1:z"] };
  assert(classifySchemaCompat(newer, null) === "first-boot", "no record must be first-boot");
  assert(classifySchemaCompat(newer, newer) === "equal", "same head must be equal");
  assert(
    classifySchemaCompat(newer, older) === "code-ahead",
    "a bundle whose lineage contains the data's head must be code-ahead",
  );
  assert(
    classifySchemaCompat(older, newer) === "data-ahead",
    "data stamped by a newer bundle must be data-ahead",
  );
  assert(
    classifySchemaCompat(older, foreign) === "unrelated",
    "disconnected histories must be unrelated",
  );
});

Deno.test("manifest and local-record parsing reject unusable shapes", () => {
  const manifest = parseSchemaCompatManifest({
    v: 1,
    revision: "abc",
    head: "v1:a",
    lineage: ["v1:a"],
  });
  assert(manifest?.head === "v1:a", "a valid manifest was rejected");
  assert(parseSchemaCompatManifest(null) === null, "null passed manifest parsing");
  assert(
    parseSchemaCompatManifest({ v: 2, revision: "abc", head: "v1:a", lineage: ["v1:a"] }) === null,
    "an unknown manifest version was accepted",
  );
  assert(
    parseSchemaCompatManifest({ v: 1, revision: "abc", head: "v1:a", lineage: ["v1:b"] }) === null,
    "a manifest whose lineage omits its head was accepted",
  );

  const record = serializeLocalSchemaVersion({ head: "v1:a", lineage: ["v1:a"] });
  assert(
    parseLocalSchemaVersion(record)?.head === "v1:a",
    "a round-tripped local record was rejected",
  );
  assert(parseLocalSchemaVersion("not json") === null, "malformed JSON passed record parsing");
  assert(parseLocalSchemaVersion(null) === null, "a missing record did not parse to null");
});
