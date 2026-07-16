import { CREATE_CORE_FILE_NAMES } from "./create_core.ts";
import { STARTER_TEMPLATE } from "./starter_template.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("generated project map enumerates the complete generator output", async () => {
  const source = await Deno.readTextFile(
    new URL("../docs/generated-project-map.md", import.meta.url),
  );
  const documented = [...source.matchAll(/^- `([^`]+)` — \*\*/gm)].map((match) => match[1]).sort();
  const generated = [
    ...Object.keys(STARTER_TEMPLATE),
    ...Object.values(CREATE_CORE_FILE_NAMES),
  ].sort();
  const missing = generated.filter((path) => !documented.includes(path));
  const stale = documented.filter((path) => !generated.includes(path));
  assert(
    missing.length === 0 && stale.length === 0,
    `generated project map drifted; missing: ${missing.join(", ") || "none"}; stale: ${
      stale.join(", ") || "none"
    }`,
  );
  assert(
    new Set(documented).size === documented.length,
    "generated project map contains duplicate paths",
  );
});
