import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runJourney } from "./golden_path.ts";
import {
  installNodeSentinel,
  runCapturedCommand,
  safeChildEnvironment,
} from "./golden_path_core.ts";
import { assert } from "./assert.ts";

const sourceRoot = resolve(Deno.cwd());
const artifactRoot = join(sourceRoot, "test-results/golden-path-create");
const temporaryRoot = await Deno.makeTempDir({ prefix: "lofi-create-golden-" });
const projectRoot = join(temporaryRoot, "lofi-app");
const journeyStartedAt = new Date();
const journeyStartedPerformanceMs = performance.now();

try {
  await Deno.remove(artifactRoot, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.mkdir(artifactRoot, { recursive: true });
  const environment = await installNodeSentinel(safeChildEnvironment(), artifactRoot);
  environment.LOFI_CREATE_DEVELOPMENT = "1";
  environment.LOFI_CREATE_PACKAGE_PREFIX = new URL("../package/", import.meta.url).href;
  const create = await runCapturedCommand({
    cwd: temporaryRoot,
    args: [
      "run",
      "-A",
      fileURLToPath(new URL("../package/create.ts", import.meta.url)),
      "lofi-app",
    ],
    environment,
    artifactRoot,
    name: "create",
  });
  if (create.exitCode !== 0) {
    throw new Error(`create failed with exit ${create.exitCode}; inspect ${create.stderrPath}`);
  }
  const createOutput = await Deno.readTextFile(create.stdoutPath);
  assert(createOutput.includes("Created lofi-app"), "create output did not name the created path");
  assert(createOutput.includes("  cd lofi-app"), "create output did not print the exact cd step");
  assert(
    createOutput.includes("  deno task dev"),
    "create output did not print the exact dev step",
  );

  const report = await runJourney({
    source: "create",
    projectRoot,
    artifactRoot,
    sourceRevisionRoot: sourceRoot,
    resetArtifactRoot: false,
    initialCommands: [create],
    commands: { doctor: "doctor" },
    authorPaths: [
      "src/app.ts",
      "src/islands",
      "src/pages",
      "src/permissions.ts",
      "src/schema.ts",
      "src/styles",
    ],
    journeyStartedAt,
    journeyStartedPerformanceMs,
    createDurationMs: create.durationMs,
    developerCommandCount: 3,
  });
  console.log(`lofi generated golden path: passed (${report.artifacts.report})`);
} catch (error) {
  console.error(
    `lofi generated golden path: failed: ${error instanceof Error ? error.message : error}`,
  );
  console.error("rerun: deno task test:golden:create");
  Deno.exitCode = 1;
} finally {
  await Deno.remove(temporaryRoot, { recursive: true }).catch(() => undefined);
}
