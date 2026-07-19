import { join } from "node:path";
import {
  duplicateBuildAssets,
  engineWasmAssets,
  engineWasmPreloadTag,
  heaviestShellAsset,
  injectHeadTags,
  precacheUrls,
  scanSecrets,
  shellWeightBytes,
  sourceFingerprint,
  walkFiles,
} from "./project.ts";

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

Deno.test("source fingerprint includes authored public JavaScript", async () => {
  const root = await makeTestRoot();
  try {
    await Deno.mkdir(join(root, "public"));
    await Deno.writeTextFile(join(root, "public", "app.js"), "const revision = 'one';\n");
    const first = await sourceFingerprint(root);
    await Deno.writeTextFile(join(root, "public", "app.js"), "const revision = 'two';\n");
    assert(first !== await sourceFingerprint(root), "fingerprint ignored authored public source");
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
    // The schema compatibility manifest is shell state: an offline shell must
    // still know its own schema range, so it stays in the precache.
    "lofi-schema.json",
    "assets\\client.js",
    "manifest.webmanifest",
    "screenshot-wide.png",
  ], ["screenshot-wide.png"]);
  assert(
    JSON.stringify(urls) === JSON.stringify([
      "./",
      "./assets/client.js",
      "./lofi-schema.json",
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

Deno.test("duplicate build assets are grouped by content and scoped to _astro", async () => {
  const root = await makeTestRoot();
  try {
    await Deno.mkdir(join(root, "_astro"));
    await Deno.writeTextFile(join(root, "_astro", "engine_bg.HASH.wasm"), "same payload");
    await Deno.writeTextFile(join(root, "_astro", "engine_bg-HASH.wasm"), "same payload");
    await Deno.writeTextFile(join(root, "_astro", "one.js"), "payload one");
    await Deno.writeTextFile(join(root, "_astro", "two.js"), "payload two");
    await Deno.writeTextFile(join(root, "copy.txt"), "same payload");
    const groups = await duplicateBuildAssets([
      "_astro/engine_bg.HASH.wasm",
      "_astro/engine_bg-HASH.wasm",
      "_astro/one.js",
      "_astro/two.js",
      "copy.txt",
    ], root);
    assert(groups.length === 1, `expected one duplicate group, received ${groups.length}`);
    assert(
      groups[0].join(", ") === "_astro/engine_bg-HASH.wasm, _astro/engine_bg.HASH.wasm",
      `same-size files were grouped by name, not content: ${groups[0].join(", ")}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shell weight sums the bytes of the precached set", async () => {
  const root = await makeTestRoot();
  try {
    await Deno.writeTextFile(join(root, "index.html"), "12345");
    await Deno.mkdir(join(root, "_astro"));
    await Deno.writeTextFile(join(root, "_astro", "client.js"), "1234567");
    const total = await shellWeightBytes(["index.html", "_astro/client.js"], root);
    assert(total === 12, `expected 12 bytes, received ${total}`);
    const heaviest = await heaviestShellAsset(["index.html", "_astro/client.js"], root);
    assert(
      heaviest?.path === "_astro/client.js" && heaviest.bytes === 7,
      `expected _astro/client.js at 7 bytes, received ${JSON.stringify(heaviest)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("engine preload tags target the engine binary and land inside head", () => {
  const distFiles = [
    "_astro/jazz_wasm_bg.MOpZeXEV.wasm",
    "_astro/runtime.CCX0HbMH.js",
    "index.html",
    "media/jazz_wasm_bg.notes.wasm.txt",
  ];
  const assets = engineWasmAssets(distFiles);
  assert(
    assets.length === 1 && assets[0] === "_astro/jazz_wasm_bg.MOpZeXEV.wasm",
    `expected the one engine binary, received ${JSON.stringify(assets)}`,
  );
  const tag = engineWasmPreloadTag(assets[0], "/app", 9_300_000);
  assert(
    tag ===
      '<link rel="preload" href="/app/_astro/jazz_wasm_bg.MOpZeXEV.wasm" as="fetch" crossorigin data-lofi-engine="9300000">',
    `unexpected preload tag: ${tag}`,
  );
  const html = "<html><head><title>t</title></head><body></body></html>";
  const injected = injectHeadTags(html, [tag]);
  assert(
    injected === `<html><head><title>t</title>${tag}</head><body></body></html>`,
    `tag was not injected before </head>: ${injected}`,
  );
  assert(
    injectHeadTags("<body>no head</body>", [tag]) === "<body>no head</body>",
    "a document without a head must pass through unchanged",
  );
  assert(injectHeadTags(html, []) === html, "no tags must leave the document unchanged");
});
