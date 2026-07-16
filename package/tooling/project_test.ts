import { join } from "node:path";
import { precacheUrls, scanSecrets, sourceFingerprint, walkFiles } from "./project.ts";

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

Deno.test("source fingerprint includes authored service worker JavaScript", async () => {
  const root = await makeTestRoot();
  try {
    await Deno.mkdir(join(root, "public"));
    await Deno.writeTextFile(join(root, "public", "sw.js"), "const revision = 'one';\n");
    const first = await sourceFingerprint(root);
    await Deno.writeTextFile(join(root, "public", "sw.js"), "const revision = 'two';\n");
    assert(first !== await sourceFingerprint(root), "fingerprint ignored service worker source");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("precache URLs are portable app-shell URLs", () => {
  const urls = precacheUrls([
    "sw.js",
    "index.html",
    "lofi-build.json",
    "lofi-precache.json",
    "assets\\client.js",
    "manifest.webmanifest",
  ]);
  assert(
    JSON.stringify(urls) === JSON.stringify([
      "./",
      "./assets/client.js",
      "./manifest.webmanifest",
    ]),
    `unexpected precache URLs: ${JSON.stringify(urls)}`,
  );
});

Deno.test({
  name: "project walking names unsupported symbolic links and the remediation",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await makeTestRoot();
    try {
      await Deno.writeTextFile(join(root, "target.ts"), "export const target = true;\n");
      const link = await new Deno.Command("ln", {
        args: ["-s", "target.ts", join(root, "linked.ts")],
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(
        link.success,
        `failed to create test symlink: ${new TextDecoder().decode(link.stderr)}`,
      );
      let message = "";
      try {
        await walkFiles(root);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert(message.includes("linked.ts"), `error did not name the symbolic link: ${message}`);
      assert(
        message.includes("replace it with a regular file or directory"),
        `error did not include remediation: ${message}`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
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
