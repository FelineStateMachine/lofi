import { normalizeDeploymentBase, pathWithinDeploymentBase } from "./base-path.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

Deno.test("deployment bases are absolute and have one trailing slash", () => {
  assertEquals(normalizeDeploymentBase(undefined), "/");
  assertEquals(normalizeDeploymentBase("/"), "/");
  assertEquals(normalizeDeploymentBase(" /field-notes "), "/field-notes/");
  assertEquals(normalizeDeploymentBase("/teams/notes/"), "/teams/notes/");
});

Deno.test("deployment bases reject origins, traversal, and URL suffixes", () => {
  for (
    const input of [
      "notes",
      "//example.com/notes",
      "/../notes",
      "/%2e%2e/notes",
      "/notes?x=1",
      "/notes#top",
      "/notes\\admin",
    ]
  ) {
    let rejected = false;
    try {
      normalizeDeploymentBase(input);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
  }
});

Deno.test("request paths resolve only inside the deployment base", () => {
  assertEquals(pathWithinDeploymentBase("/field-notes/", "/field-notes/"), "");
  assertEquals(pathWithinDeploymentBase("/field-notes/settings/", "/field-notes/"), "settings/");
  assertEquals(pathWithinDeploymentBase("/field-notes", "/field-notes/"), "");
  assertEquals(pathWithinDeploymentBase("/other/", "/field-notes/"), null);
  assertEquals(pathWithinDeploymentBase("/settings/", "/"), "settings/");
});
