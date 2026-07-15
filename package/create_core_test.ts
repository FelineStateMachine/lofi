import { join } from "node:path";
import { createProject } from "./create_core.ts";

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
    assertEquals(actual, expected);
    const config = JSON.parse(await Deno.readTextFile(join(result.destination, "deno.json")));
    assertEquals(config.imports["@nzip/lofi/"], "jsr:@nzip/lofi@0.1.0/");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
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
