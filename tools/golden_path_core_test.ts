import { join, resolve } from "node:path";
import { assert } from "./assert.ts";
import {
  installNodeSentinel,
  materializeCleanProject,
  probeHttpReady,
  redactText,
  reserveLocalPort,
  runCapturedCommand,
  safeChildEnvironment,
  scanAuthorBoundary,
  startReadyProcess,
  withDeadline,
} from "./golden_path_core.ts";

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

Deno.test("clean project materialization copies only tracked files from a repository", async () => {
  const source = await workspaceTemp("tracked-source");
  const destination = await workspaceTemp("tracked-destination");
  try {
    await Deno.writeTextFile(join(source, "tracked.ts"), "export const tracked = true;\n");
    await Deno.writeTextFile(join(source, "untracked.ts"), "export const untracked = true;\n");
    for (const args of [["init", "-q"], ["add", "tracked.ts"]]) {
      const output = await new Deno.Command("git", { args, cwd: source }).output();
      assert(output.success, `git ${args[0]} fixture setup failed`);
    }

    await materializeCleanProject(source, destination);
    assert(await exists(join(destination, "tracked.ts")), "tracked source must be copied");
    assert(!await exists(join(destination, "untracked.ts")), "untracked source must be excluded");
  } finally {
    await Promise.all([
      removeWorkspaceTemp(source),
      removeWorkspaceTemp(destination),
    ]);
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

Deno.test("HTTP readiness waits until an early advertised URL accepts requests", async () => {
  const artifacts = await workspaceTemp("golden-http-ready");
  const port = reserveLocalPort();
  const url = `http://127.0.0.1:${port}/`;
  const started = performance.now();
  const process = startReadyProcess({
    executable: Deno.execPath(),
    cwd: Deno.cwd(),
    args: [
      "eval",
      `console.log("READY ${url}"); await new Promise((resolve) => setTimeout(resolve, 200)); Deno.serve({ hostname: "127.0.0.1", port: ${port} }, () => new Response("ready")); await new Promise(() => {});`,
    ],
    environment: safeChildEnvironment({}),
    artifactRoot: artifacts,
    name: "early-banner",
    readyPattern: /READY (http:\/\/127\.0\.0\.1:\d+\/)/,
    readyCheck: probeHttpReady,
    timeoutMs: 5_000,
  });
  try {
    assert(await process.ready === url, "the accepting URL should satisfy readiness");
    assert(
      performance.now() - started >= 150,
      "a printed banner must not resolve before the listener accepts requests",
    );
  } finally {
    await process.stop();
    await removeWorkspaceTemp(artifacts);
  }
});

Deno.test("post-banner exit rejects with retained diagnostics", async () => {
  const artifacts = await workspaceTemp("golden-http-exit");
  const port = reserveLocalPort();
  const process = startReadyProcess({
    executable: Deno.execPath(),
    cwd: Deno.cwd(),
    args: [
      "eval",
      `console.log("READY http://127.0.0.1:${port}/"); console.error("unique post-banner failure"); Deno.exit(42);`,
    ],
    environment: safeChildEnvironment({}),
    artifactRoot: artifacts,
    name: "post-banner-exit",
    readyPattern: /READY (http:\/\/127\.0\.0\.1:\d+\/)/,
    readyCheck: probeHttpReady,
    timeoutMs: 5_000,
  });
  try {
    let message = "";
    try {
      await process.ready;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("exited with 42"), "readiness must report the process exit code");
    assert(message.includes("unique post-banner failure"), "readiness must include stderr tail");
    assert(message.includes(process.stderrPath), "readiness must point to retained stderr");
    await process.completed;
  } finally {
    await process.stop();
    await removeWorkspaceTemp(artifacts);
  }
});

Deno.test("stopping a ready wrapper terminates its serving grandchild", async () => {
  if (Deno.build.os === "windows") return;
  const artifacts = await workspaceTemp("golden-process-tree");
  const port = reserveLocalPort();
  const url = `http://127.0.0.1:${port}/`;
  const serverSource =
    `Deno.serve({ hostname: "127.0.0.1", port: ${port} }, () => new Response("child")); await new Promise(() => {});`;
  const wrapperSource = `const child = new Deno.Command(Deno.execPath(), { args: ["eval", ${
    JSON.stringify(serverSource)
  }], stdout: "inherit", stderr: "inherit" }).spawn(); console.log("READY ${url}"); await child.status;`;
  const process = startReadyProcess({
    executable: Deno.execPath(),
    cwd: Deno.cwd(),
    args: ["eval", wrapperSource],
    environment: safeChildEnvironment({}),
    artifactRoot: artifacts,
    name: "wrapper-tree",
    readyPattern: /READY (http:\/\/127\.0\.0\.1:\d+\/)/,
    readyCheck: probeHttpReady,
    timeoutMs: 5_000,
  });
  try {
    await process.ready;
    await process.stop();
    const rebound = Deno.listen({ hostname: "127.0.0.1", port });
    rebound.close();
  } finally {
    await process.stop().catch(() => undefined);
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
