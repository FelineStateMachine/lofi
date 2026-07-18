// Repo contract test: the static `.lofi/` vendoring manifests must track the
// actual package directories. The lists are static because the published
// package cannot enumerate directories over JSR — this test is what fails
// when a new runtime module lands without being added to the manifest
// (namespace-state.ts and transport-gate.ts shipped exactly that way and
// broke every generated project's build until vendoring caught up).
import { accessFiles, preactFiles, recipeFiles, runtimeFiles, schemaFiles } from "./mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Files that live in the source directories but are deliberately not vendored.
const notVendored = new Set([
  "sw.js", // copied by the build command with its revision stamped in
  "test-assert.ts", // package test helper
]);

async function moduleEntries(directory: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(new URL(`../${directory}`, import.meta.url))) {
    if (!entry.isFile) continue;
    if (entry.name.endsWith("_test.ts") || entry.name.endsWith("_test.tsx")) continue;
    if (notVendored.has(entry.name)) continue;
    if (!/\.(ts|tsx|d\.ts)$/.test(entry.name)) continue;
    names.push(entry.name);
  }
  return names.sort();
}

const manifests: ReadonlyArray<[string, readonly string[]]> = [
  ["runtime", runtimeFiles],
  ["access", accessFiles],
  ["preact", preactFiles],
  ["recipes", recipeFiles],
  ["schema", schemaFiles],
];

Deno.test("the .lofi vendoring manifests match the package directories", async () => {
  for (const [directory, manifest] of manifests) {
    const actual = await moduleEntries(directory);
    const listed = [...manifest].sort();
    const missing = actual.filter((name) => !listed.includes(name));
    const stale = listed.filter((name) => !actual.includes(name));
    assert(
      missing.length === 0,
      `package/${directory} contains modules missing from the vendoring manifest: ${
        missing.join(", ")
      } — generated projects cannot build without them`,
    );
    assert(
      stale.length === 0,
      `the vendoring manifest lists modules absent from package/${directory}: ${stale.join(", ")}`,
    );
  }
});
