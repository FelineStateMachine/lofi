import { join } from "node:path";
import { scanSecrets, sourceFingerprint } from "./project.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeTestRoot(): Promise<string> {
  return Deno.makeTempDir({ dir: ".", prefix: ".lofi-project-test-" });
}

Deno.test("source fingerprint is stable across file creation order and changes with content", async () => {
  const left = await makeTestRoot();
  const right = await makeTestRoot();
  try {
    await Deno.mkdir(join(left, "src"));
    await Deno.writeTextFile(join(left, "src", "b.ts"), "export const b = 2;\n");
    await Deno.writeTextFile(join(left, "src", "a.ts"), "export const a = 1;\n");
    await Deno.mkdir(join(right, "src"));
    await Deno.writeTextFile(join(right, "src", "a.ts"), "export const a = 1;\n");
    await Deno.writeTextFile(join(right, "src", "b.ts"), "export const b = 2;\n");
    assert(
      await sourceFingerprint(left) === await sourceFingerprint(right),
      "fingerprint depends on file creation order",
    );
    await Deno.writeTextFile(join(right, "src", "b.ts"), "export const b = 3;\n");
    assert(
      await sourceFingerprint(left) !== await sourceFingerprint(right),
      "fingerprint ignored source content",
    );
  } finally {
    await Deno.remove(left, { recursive: true });
    await Deno.remove(right, { recursive: true });
  }
});

Deno.test("secret scan ignores the local env source but catches source and build leaks", async () => {
  const root = await makeTestRoot();
  const secret = "generated-command-secret-fixture";
  try {
    await Deno.mkdir(join(root, "src"));
    await Deno.mkdir(join(root, "dist"));
    await Deno.writeTextFile(join(root, ".env"), `BACKEND_SECRET=${secret}\n`);
    await Deno.writeTextFile(join(root, "src", "safe.ts"), "export const safe = true;\n");
    await Deno.writeTextFile(
      join(root, "dist", "client.js"),
      `const leaked = ${JSON.stringify(secret)};`,
    );
    const result = await scanSecrets({ BACKEND_SECRET: secret }, root);
    assert(result.leaks.length === 1, `expected one build leak, received ${result.leaks.length}`);
    assert(result.leaks[0].path === "dist/client.js", "secret scan reported the wrong file");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
