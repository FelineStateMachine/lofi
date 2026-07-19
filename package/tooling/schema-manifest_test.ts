import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { computeSchemaFingerprint, parseSchemaCompatManifest } from "../schema/compat.ts";
import { findSchemaAppExport, generateSchemaCompatManifest } from "./schema-manifest.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const schemaModuleUrl = pathToFileURL(
  join(import.meta.dirname!, "..", "schema", "mod.ts"),
).href;

async function makeProject(schemaSource: string): Promise<string> {
  const root = await Deno.makeTempDir({ dir: ".", prefix: ".lofi-schema-manifest-test-" });
  await Deno.mkdir(join(root, "src"), { recursive: true });
  await Deno.writeTextFile(join(root, "src", "schema.ts"), schemaSource);
  return root;
}

const v1Source = `import { s } from ${JSON.stringify(schemaModuleUrl)};
export const app = s.defineApp({
  todos: s.table({ title: s.string(), done: s.boolean() }),
});
`;

const v2Source = `import { s } from ${JSON.stringify(schemaModuleUrl)};
export const app = s.defineApp({
  todos: s.table({ title: s.string(), done: s.boolean(), note: s.string() }),
});
`;

Deno.test("the build manifest stamps the schema head for the given revision", async () => {
  const root = await makeProject(v1Source);
  try {
    const manifest = await generateSchemaCompatManifest({ revision: "rev-1", root });
    assert(parseSchemaCompatManifest(manifest) !== null, "generated manifest failed to parse");
    assert(manifest.revision === "rev-1", "manifest lost the build revision");
    assert(/^v1:[0-9a-f]{16}$/.test(manifest.head), `manifest head is malformed: ${manifest.head}`);
    assert(
      manifest.lineage.length === 1 && manifest.lineage[0] === manifest.head,
      "an unmigrated project's lineage is not exactly its head",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("committed migration snapshots become the manifest lineage", async () => {
  const root = await makeProject(v2Source);
  try {
    // The committed snapshot of the previous schema, as `migrations create`
    // writes it: the prior schema in wasm form.
    const previous = await makeProject(v1Source);
    let previousWasm: Record<string, unknown>;
    try {
      const moduleExports = await import(
        pathToFileURL(join(previous, "src", "schema.ts")).href
      ) as { app: { wasmSchema: Record<string, unknown> } };
      previousWasm = moduleExports.app.wasmSchema;
    } finally {
      await Deno.remove(previous, { recursive: true });
    }
    const snapshots = join(root, "src", "migrations", "snapshots");
    await Deno.mkdir(snapshots, { recursive: true });
    await Deno.writeTextFile(
      join(snapshots, "20260101T000000-abcdef123456.json"),
      `${JSON.stringify(previousWasm)}\n`,
    );
    const manifest = await generateSchemaCompatManifest({ revision: "rev-2", root });
    const ancestor = await computeSchemaFingerprint(previousWasm);
    assert(manifest.lineage.includes(manifest.head), "lineage omitted the head");
    assert(manifest.lineage.includes(ancestor), "lineage omitted the snapshot ancestor");
    assert(manifest.head !== ancestor, "the migrated schema collided with its ancestor");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a schema module without an app value fails with an actionable error", async () => {
  const root = await makeProject(`export const notAnApp = { tables: [] };\n`);
  try {
    let message = "";
    try {
      await generateSchemaCompatManifest({ revision: "rev-3", root });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("does not export an app value"), `unhelpful error: ${message}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the app export is found by name or as the single app-shaped export", () => {
  const app = { wasmSchema: { todos: { columns: [] } } };
  assert(findSchemaAppExport({ app }) === app, "the app export was not preferred");
  assert(
    findSchemaAppExport({ v2: app, migration: { forward: [] } }) === app,
    "a single renamed app export was not found",
  );
  let message = "";
  try {
    findSchemaAppExport({ v1: app, v2: { wasmSchema: { notes: { columns: [] } } } });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("several app values"), `ambiguity was not reported: ${message}`);
});
