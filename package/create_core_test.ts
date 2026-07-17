import { join } from "node:path";
import packageManifest from "../deno.json" with { type: "json" };
import { createProject } from "./create_core.ts";
import { LOFI_VERSION } from "./version.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
          ([key, child]) => [key, canonical(child)],
        ),
      );
    }
    return value;
  };
  const actualJson = JSON.stringify(canonical(actual));
  const expectedJson = JSON.stringify(canonical(expected));
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, received ${actualJson}`);
  }
}

async function assertRejects(
  action: () => Promise<unknown>,
  messageIncludes: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(messageIncludes), `expected error to include ${messageIncludes}`);
    return;
  }
  throw new Error("expected promise to reject");
}

async function fileManifest(root: string): Promise<Record<string, string>> {
  const manifest: Record<string, string> = {};
  async function visit(path: string, prefix = "") {
    const entries = [...Deno.readDirSync(path)].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = join(path, entry.name);
      if (entry.isDirectory) await visit(child, relative);
      else if (entry.isFile) {
        const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(child));
        manifest[relative] = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      }
    }
  }
  await visit(root);
  return manifest;
}

function snapshotDelta(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort().filter((path) =>
    actual[path] !== expected[path]
  );
}

function makeTestRoot(): Promise<string> {
  return Deno.makeTempDir({ dir: ".", prefix: ".lofi-create-test-" });
}

Deno.test("createProject materializes the complete starter snapshot", async () => {
  const cwd = await makeTestRoot();
  try {
    const result = await createProject({ cwd, name: "starter" });
    assertEquals(result.nextCommands, ["cd starter", "deno task dev"]);
    const actual = await fileManifest(result.destination);
    const expected = JSON.parse(
      await Deno.readTextFile(new URL("./testdata/starter.snapshot.json", import.meta.url)),
    );
    if (Deno.env.get("LOFI_UPDATE_SNAPSHOT") === "1") {
      await Deno.writeTextFile(
        new URL("./testdata/starter.snapshot.json", import.meta.url),
        `${JSON.stringify(actual, null, 2)}\n`,
      );
    } else {
      const changed = snapshotDelta(actual, expected);
      assert(
        changed.length === 0,
        `generated starter snapshot changed: ${
          changed.join(", ")
        }. Review the generated files, then run \`deno task test:update:create\` to accept them.`,
      );
    }
    const config = JSON.parse(await Deno.readTextFile(join(result.destination, "deno.json")));
    assertEquals(config.imports["@nzip/lofi"], "jsr:@nzip/lofi@0.2.0");
    assertEquals(config.imports["@nzip/lofi/"], "jsr:@nzip/lofi@0.2.0/");
    assertEquals(config.imports["@nzip/lofi/testing"], "jsr:@nzip/lofi@0.2.0/testing");
    const lofiSpecifiers = Object.entries(config.imports)
      .filter(([name]) => name.startsWith("@nzip/lofi/"))
      .map(([, specifier]) => String(specifier));
    assert(
      lofiSpecifiers.length === 10,
      `expected one package prefix, two integrations, six commands, and testing, received ${lofiSpecifiers.length}`,
    );
    assert(
      lofiSpecifiers.every((specifier) => specifier.startsWith("jsr:@nzip/lofi@0.2.0/")),
      "generated lofi commands do not resolve through one exact package version",
    );
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (
      const icon of [
        "apple-touch-icon.png",
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-512.png",
      ]
    ) {
      const bytes = await Deno.readFile(join(result.destination, "public", icon));
      assert(
        pngSignature.every((byte, index) => bytes[index] === byte),
        `generated ${icon} was not copied as binary PNG data`,
      );
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("package manifest and generated version stay coupled", () => {
  assertEquals(packageManifest.name, "@nzip/lofi");
  assertEquals(packageManifest.version, LOFI_VERSION);
  assertEquals(Object.keys(packageManifest.exports).sort(), [
    ".",
    "./astro",
    "./build",
    "./create",
    "./dev",
    "./doctor",
    "./preact",
    "./preview",
    "./provision",
    "./test",
    "./testing",
  ]);
  assertEquals(packageManifest.exports["."], "./package/runtime/mod.ts");
  assertEquals(packageManifest.exports["./astro"], "./package/astro/mod.ts");
  assertEquals(packageManifest.exports["./preact"], "./package/preact/mod.ts");
  assertEquals(packageManifest.exports["./testing"], "./package/testing/mod.ts");
});

Deno.test("createProject refuses a non-empty destination without changing it", async () => {
  const cwd = await makeTestRoot();
  const destination = join(cwd, "taken");
  const marker = join(destination, "keep.txt");
  try {
    await Deno.mkdir(destination);
    await Deno.writeTextFile(marker, "untouched");
    await assertRejects(() => createProject({ cwd, name: "taken" }), "no files were changed");
    assertEquals(await Deno.readTextFile(marker), "untouched");
    assertEquals([...Deno.readDirSync(destination)].map((entry) => entry.name), ["keep.txt"]);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("createProject refuses path traversal without creating an outside directory", async () => {
  const cwd = await makeTestRoot();
  const outside = join(cwd, "..", "outside-from-lofi-create-test");
  try {
    await Deno.remove(outside, { recursive: true }).catch(() => undefined);
    await assertRejects(
      () => createProject({ cwd, name: "../outside-from-lofi-create-test" }),
      "'..'",
    );
    try {
      await Deno.stat(outside);
      throw new Error("path traversal created an outside destination");
    } catch (error) {
      assert(error instanceof Deno.errors.NotFound, "unexpected outside traversal path state");
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
    await Deno.remove(outside, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("createProject accepts an existing empty directory and a local package override", async () => {
  const cwd = await makeTestRoot();
  try {
    await Deno.mkdir(join(cwd, "nested", "starter"), { recursive: true });
    const result = await createProject({
      cwd,
      name: "nested/starter",
      packagePrefix: "file:///clean-room/package/",
    });
    const config = JSON.parse(await Deno.readTextFile(join(result.destination, "deno.json")));
    assertEquals(config.imports["@nzip/lofi"], "file:///clean-room/package/runtime/mod.ts");
    assertEquals(config.imports["@nzip/lofi/"], "file:///clean-room/package/");
    assert(
      !await Array.fromAsync(Deno.readDir(result.destination)).then((entries) =>
        entries.some((entry) => entry.name === ".env")
      ),
      "generated project must not contain .env",
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test({
  name: "createProject refuses destinations reached through a symbolic link",
  ignore: Deno.build.os === "windows",
  async fn() {
    const cwd = await makeTestRoot();
    const outside = await makeTestRoot();
    try {
      const link = await new Deno.Command("ln", {
        args: ["-s", outside, join(cwd, "linked")],
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(
        link.success,
        `failed to create test symlink: ${new TextDecoder().decode(link.stderr)}`,
      );
      await assertRejects(
        () => createProject({ cwd, name: "linked/starter" }),
        "crosses symbolic link",
      );
      assertEquals([...Deno.readDirSync(outside)].length, 0);
    } finally {
      await Deno.remove(cwd, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  },
});
