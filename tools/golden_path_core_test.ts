import { join, resolve } from "node:path";
import {
  installNodeSentinel,
  materializeCleanProject,
  redactText,
  runCapturedCommand,
  safeChildEnvironment,
  scanAuthorBoundary,
  startReadyProcess,
  withDeadline,
} from "./golden_path_core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function workspaceTemp(prefix: string): Promise<string> {
  return await Deno.makeTempDir({ dir: ".", prefix: `.lofi-${prefix}-` });
}

async function removeWorkspaceTemp(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}

Deno.test("safe child environment removes ambient application configuration", () => {
  const environment = safeChildEnvironment({
    PATH: "/test/bin",
    DENO_DIR: "/test/deno",
    JAZZ_APP_ID: "public-id",
    JAZZ_SERVER_URL: "https://sync.invalid",
    JAZZ_ADMIN_SECRET: "admin-secret",
    BACKEND_SECRET: "backend-secret",
    UNRELATED_SECRET: "also-secret",
  });

  assert(environment.PATH === "/test/bin", "PATH should remain available to Deno tasks");
  assert(environment.DENO_DIR === "/test/deno", "the explicit Deno cache should remain available");
  assert(environment.CI === "1", "clean-room commands should have deterministic CI output");
  assert(environment.JAZZ_APP_ID === "", "public application configuration must be cleared");
  assert(environment.JAZZ_ADMIN_SECRET === "", "server configuration must be cleared");
  assert(!("UNRELATED_SECRET" in environment), "unrelated ambient secrets must not be inherited");
});

Deno.test("retained evidence redacts allowlisted configuration values", () => {
  const output = redactText(
    "app id public-id server https://sync.invalid secret server-secret",
    ["public-id", "https://sync.invalid", "server-secret"],
  );
  assert(!output.includes("public-id"), "the app id must be redacted");
  assert(!output.includes("sync.invalid"), "the server URL must be redacted");
  assert(!output.includes("server-secret"), "server secrets must be redacted");
  assert(output.match(/\[redacted\]/g)?.length === 3, "every configured value must be replaced");
});

Deno.test("Node sentinel is first on PATH", async () => {
  if (Deno.build.os === "windows") return;
  const root = await workspaceTemp("node-sentinel");
  try {
    const environment = await installNodeSentinel({ PATH: "/allowed/bin" }, root);
    const sentinel = environment.PATH.split(":")[0];
    assert(
      resolve(sentinel).startsWith(resolve(root)),
      "the sentinel directory must be first on PATH",
    );
    assert(
      (await Deno.readTextFile(join(sentinel, "node"))).includes("hidden Node invocation"),
      "the sentinel must fail with an actionable message",
    );
  } finally {
    await removeWorkspaceTemp(root);
  }
});

Deno.test("clean project copy excludes secrets caches and the retired prototype", async () => {
  const source = await workspaceTemp("golden-source");
  const destination = await workspaceTemp("golden-destination");
  try {
    await Deno.mkdir(join(source, "apps/prototype"), { recursive: true });
    await Deno.mkdir(join(source, "apps/reference/src"), { recursive: true });
    await Deno.mkdir(join(source, "apps/reference/node_modules/package"), { recursive: true });
    await Deno.mkdir(join(source, "apps/reference/dist"), { recursive: true });
    await Deno.mkdir(join(source, ".nzip-site"), { recursive: true });
    await Promise.all([
      Deno.writeTextFile(join(source, ".env"), "BACKEND_SECRET=do-not-copy\n"),
      Deno.writeTextFile(join(source, ".env.local"), "JAZZ_APP_ID=do-not-copy\n"),
      Deno.writeTextFile(join(source, ".env.example"), "JAZZ_APP_ID=\n"),
      Deno.writeTextFile(join(source, "apps/prototype/retired.ts"), "retired\n"),
      Deno.writeTextFile(join(source, "apps/reference/src/app.ts"), "export const app = {};\n"),
      Deno.writeTextFile(join(source, "apps/reference/node_modules/package/index.js"), "cache\n"),
      Deno.writeTextFile(join(source, "apps/reference/dist/index.html"), "build\n"),
      Deno.writeTextFile(join(source, ".nzip-site/index.html"), "hosted\n"),
    ]);

    await materializeCleanProject(source, destination);
    assert(await exists(join(destination, ".env.example")), ".env.example should be copied");
    assert(
      await exists(join(destination, "apps/reference/src/app.ts")),
      "source should be copied",
    );
    assert(!await exists(join(destination, ".env")), ".env must be excluded");
    assert(!await exists(join(destination, ".env.local")), ".env.local must be excluded");
    assert(
      !await exists(join(destination, "apps/prototype")),
      "retired prototype must be excluded",
    );
    assert(
      !await exists(join(destination, "apps/reference/node_modules")),
      "node_modules must be excluded",
    );
    assert(!await exists(join(destination, "apps/reference/dist")), "dist must be excluded");
    assert(!await exists(join(destination, ".nzip-site")), "hosted artifacts must be excluded");
  } finally {
    await Promise.all([removeWorkspaceTemp(source), removeWorkspaceTemp(destination)]);
  }
});

Deno.test("author boundary permits schema declarations and reports UI plumbing", async () => {
  const root = await workspaceTemp("golden-boundary");
  try {
    await Deno.mkdir(join(root, "src/islands"), { recursive: true });
    await Promise.all([
      Deno.writeTextFile(
        join(root, "src/schema.ts"),
        'import { co } from "jazz-tools";\nexport const schema = co;\n',
      ),
      Deno.writeTextFile(
        join(root, "src/permissions.ts"),
        'import type { Group } from "jazz-tools";\nexport type Permission = Group;\n',
      ),
      Deno.writeTextFile(
        join(root, "src/islands/App.tsx"),
        'import { createDb } from "jazz-tools";\nconst ready = navigator.storage.persisted();\n',
      ),
    ]);

    const violations = await scanAuthorBoundary(root, ["src"]);
    assert(violations.length === 3, `expected three violations, found ${violations.length}`);
    assert(
      violations.every((violation) => violation.path === "src/islands/App.tsx"),
      "schema and permissions should retain the explicit M1 exception",
    );
    assert(
      violations.some((violation) => violation.rule === "raw-jazz-runtime-import"),
      "raw imports in product UI should be reported",
    );
    assert(
      violations.some((violation) => violation.rule === "raw-jazz-client-api"),
      "raw client construction should be reported",
    );
    assert(
      violations.some((violation) => violation.rule === "browser-capability-branch"),
      "capability branching should be reported",
    );
  } finally {
    await removeWorkspaceTemp(root);
  }
});

Deno.test("process readiness resolves from output rather than a fixed sleep", async () => {
  const artifacts = await workspaceTemp("golden-process");
  try {
    const process = startReadyProcess({
      executable: "git",
      cwd: Deno.cwd(),
      args: ["--version"],
      environment: safeChildEnvironment({}),
      artifactRoot: artifacts,
      name: "ready-control",
      readyPattern: /(git version [^\n]+)/,
      timeoutMs: 5_000,
    });
    assert(
      (await process.ready).startsWith("git version "),
      "the emitted control line should satisfy readiness",
    );
    assert((await process.completed).success, "the readiness control should exit successfully");
    await process.stop();
  } finally {
    await removeWorkspaceTemp(artifacts);
  }
});

Deno.test("captured commands retain output and duration", async () => {
  const artifacts = await workspaceTemp("golden-command");
  try {
    const record = await runCapturedCommand({
      executable: "git",
      cwd: Deno.cwd(),
      args: ["--version"],
      environment: safeChildEnvironment({}),
      artifactRoot: artifacts,
      name: "capture-control",
    });
    assert(record.exitCode === 0, "the control command should pass");
    assert(record.durationMs >= 0, "duration should be retained");
    assert(
      (await Deno.readTextFile(record.stdoutPath)).includes("git version"),
      "stdout should be retained",
    );
  } finally {
    await removeWorkspaceTemp(artifacts);
  }
});

Deno.test("deadline helper preserves a readiness result", async () => {
  assert(
    await withDeadline(Promise.resolve("ready"), 1_000, "control") === "ready",
    "a ready operation should win the deadline race",
  );
});
