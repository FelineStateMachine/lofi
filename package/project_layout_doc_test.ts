import { join, relative } from "node:path";
import { createProject } from "./create_core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function generatedFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string) {
    for await (const entry of Deno.readDir(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory) await visit(path);
      else if (entry.isFile) files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return files.sort();
}

function documentedFiles(markdown: string): string[] {
  const start = "<!-- generated-file-map:start -->";
  const end = "<!-- generated-file-map:end -->";
  const section = markdown.slice(markdown.indexOf(start) + start.length, markdown.indexOf(end));
  assert(markdown.includes(start) && markdown.includes(end), "project map markers are missing");
  return [...section.matchAll(/^\|\s+`([^`]+)`\s+\|/gm)].map((match) => match[1]).sort();
}

Deno.test("documented project map matches a real generated project", async () => {
  const temporaryRoot = await Deno.makeTempDir({ dir: ".", prefix: ".lofi-layout-doc-test-" });
  try {
    const project = await createProject({ cwd: temporaryRoot, name: "mapped-app" });
    const actual = await generatedFiles(project.destination);
    const markdown = await Deno.readTextFile(
      new URL("../docs/reference/project-layout.md", import.meta.url),
    );
    const documented = documentedFiles(markdown);
    assert(
      JSON.stringify(actual) === JSON.stringify(documented),
      `generated project map drifted\nactual: ${actual.join(", ")}\ndocumented: ${
        documented.join(", ")
      }`,
    );
  } finally {
    await Deno.remove(temporaryRoot, { recursive: true });
  }
});
