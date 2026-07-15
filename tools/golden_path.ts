import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { environmentNames, validateEnvironment } from "./env_contract.ts";
import {
  artifactPaths,
  type CapturedProcess,
  type CommandRecord,
  initializeFixtureGit,
  installNodeSentinel,
  type JourneyAssertion,
  type JourneyReport,
  type JourneySource,
  materializeCleanProject,
  probeHttpReady,
  reserveLocalPort,
  runCapturedCommand,
  safeChildEnvironment,
  scanAuthorBoundary,
  startReadyProcess,
  writeJourneyReport,
} from "./golden_path_core.ts";
import { loadEnvironment } from "./load_env.ts";
import { checklistUi } from "../apps/reference/src/ui-contract.ts";

export type GoldenPathCommands = {
  dev: string;
  check: string;
  test: string;
  build: string;
  preview: string;
};

export type GoldenPathOptions = {
  source: JourneySource;
  /** Repository working tree for checkout mode, or the already-created project for create mode. */
  projectRoot?: string;
  artifactRoot?: string;
  authorPaths?: string[];
  commands?: Partial<GoldenPathCommands>;
  cacheMode?: "existing" | "cold";
  environmentMode?: "isolated-local" | "cloud-from-root";
  timeoutMs?: number;
  islandLabels?: [string, string];
};

const defaultCommands: GoldenPathCommands = {
  dev: "dev",
  check: "check",
  test: "test",
  build: "build",
  preview: "preview",
};

const defaultAuthorPaths = [
  "apps/reference/src/app.ts",
  "apps/reference/src/islands",
  "apps/reference/src/pages",
  "apps/reference/src/permissions.ts",
  "apps/reference/src/schema.ts",
  "apps/reference/src/styles",
];

const retainedBody = "Golden path retained item";
const updatedBody = "Golden path retained item updated";
const disposableBody = "Golden path disposable item";
const offlineDevelopmentBody = "Golden path development offline item";
const offlineProductionBody = "Golden path production offline item";
const offlineProductionSyncedBody = "Golden path production offline item synced";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function taskArgs(task: string, extra: string[] = []): string[] {
  return ["task", task, ...(extra.length > 0 ? ["--", ...extra] : [])];
}

function escaped(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForItem(
  page: Page,
  islandLabels: readonly string[],
  body: string,
): Promise<void> {
  for (const [index, label] of islandLabels.entries()) {
    const island = page.locator("[data-island]").filter({ hasText: label });
    const item = island.getByRole("listitem").filter({ hasText: body });
    if (index === 0) {
      const failure = island.getByRole("status").filter({ hasText: checklistUi.writeFailed });
      await item.or(failure).waitFor({ state: "visible" });
      if (await failure.isVisible()) {
        throw new Error((await failure.textContent()) ?? "Write failed");
      }
    } else {
      await item.waitFor({ state: "visible" });
    }
  }
}

async function waitForItemAbsent(
  page: Page,
  islandLabels: readonly string[],
  body: string,
): Promise<void> {
  for (const label of islandLabels) {
    const island = page.locator("[data-island]").filter({ hasText: label });
    await island.getByRole("listitem").filter({ hasText: body }).waitFor({ state: "detached" });
  }
}

async function addItem(page: Page, island: string, body: string): Promise<void> {
  const section = page.locator("[data-island]").filter({ hasText: island });
  const textbox = section.getByRole("textbox", { name: checklistUi.newItem });
  try {
    await textbox.waitFor({ state: "visible" });
  } catch (error) {
    throw new Error(
      `reference UI is missing accessible textbox "${checklistUi.newItem}" in ${island}; #9 must expose CRUD controls`,
      { cause: error },
    );
  }
  await textbox.fill(body);
  const add = section.getByRole("button", { name: checklistUi.addFrom(island) });
  try {
    await add.waitFor({ state: "visible" });
  } catch (error) {
    throw new Error(
      `reference UI is missing accessible button "${
        checklistUi.addFrom(island)
      }"; #9 must expose CRUD controls`,
      { cause: error },
    );
  }
  await add.click();
}

async function waitForLocalDurability(page: Page): Promise<void> {
  await page.getByRole("status").filter({
    hasText: new RegExp(
      `(?:${escaped(checklistUi.lastWrite("local"))}|${escaped(checklistUi.lastWrite("global"))})`,
    ),
  }).first().waitFor({ state: "visible" });
}

async function assertRuntimeCardinality(
  page: Page,
  islandLabels: readonly string[],
): Promise<void> {
  assert(islandLabels.length === 2, "golden path cardinality requires two mounted islands");
  await page.waitForFunction(() => {
    const probe = (globalThis as typeof globalThis & {
      __LOFI_REFERENCE__?: {
        diagnostics(): {
          storageState: string;
          activeClients: number;
          activeConsumers: number;
          activeVendorSubscriptions: number;
          activeMutationListeners: number;
        };
      };
    }).__LOFI_REFERENCE__;
    const diagnostics = probe?.diagnostics();
    return diagnostics?.storageState === "persistent-driver-open" &&
      diagnostics.activeClients === 1 &&
      diagnostics.activeConsumers === 2 &&
      diagnostics.activeVendorSubscriptions === 1 &&
      diagnostics.activeMutationListeners === 1;
  });
}

async function setReferenceConnection(page: Page, connected: boolean): Promise<void> {
  await page.evaluate(async (shouldConnect) => {
    const probe = (globalThis as typeof globalThis & {
      __LOFI_REFERENCE__?: {
        disconnect(): Promise<void>;
        reconnect(): Promise<void>;
      };
    }).__LOFI_REFERENCE__;
    if (!probe) throw new Error("development reference probe is unavailable");
    if (shouldConnect) await probe.reconnect();
    else await probe.disconnect();
  }, connected);
}

async function observeReconnectSettlement(
  page: Page,
  timeoutMs: number,
  required: boolean,
): Promise<JourneyAssertion> {
  if (!required) {
    return {
      name: "development reconnect settlement",
      status: "blocked",
      detail:
        "Local-only mode has no global durability endpoint; offline retention passed, but this run makes no transport convergence claim.",
    };
  }
  try {
    const global = page.getByRole("status").filter({
      hasText: checklistUi.lastWrite("global"),
    }).first();
    const failure = page.getByRole("status").filter({ hasText: checklistUi.writeFailed }).first();
    await global.or(failure).waitFor({
      state: "visible",
      timeout: Math.min(timeoutMs, 10_000),
    });
    if (await failure.isVisible()) {
      throw new Error((await failure.textContent()) ?? "Write failed");
    }
    return {
      name: "development reconnect settlement",
      status: "passed",
      detail: "The configured development server exposed global settlement after network return.",
    };
  } catch {
    throw new Error(
      "cloud evidence failed: reconnect did not expose global settlement before the readiness deadline",
    );
  }
}

async function journeyEnvironment(
  sourceRoot: string,
  mode: "isolated-local" | "cloud-from-root",
  artifactRoot: string,
): Promise<Record<string, string>> {
  const isolated = safeChildEnvironment();
  if (mode === "isolated-local") return await installNodeSentinel(isolated, artifactRoot);

  const configured = await loadEnvironment(join(sourceRoot, ".env"));
  const validation = validateEnvironment(configured);
  if (!validation.ok) throw new Error(validation.errors.join(" "));
  if (validation.mode !== "cloud-configured") {
    throw new Error(
      "cloud evidence requires the complete JAZZ_APP_ID/JAZZ_SERVER_URL pair in the root .env or process environment",
    );
  }
  const allowlisted = { ...isolated };
  for (const name of environmentNames) allowlisted[name] = configured[name]?.trim() ?? "";
  return await installNodeSentinel(allowlisted, artifactRoot);
}

async function updateItem(page: Page, body: string, nextBody: string): Promise<void> {
  const edit = page.getByRole("button", { name: checklistUi.edit(body), exact: true }).first();
  try {
    await edit.click();
  } catch (error) {
    throw new Error(`reference UI is missing accessible button "${checklistUi.edit(body)}"`, {
      cause: error,
    });
  }
  const textbox = page.getByRole("textbox", { name: checklistUi.edit(body), exact: true }).first();
  try {
    await textbox.fill(nextBody);
  } catch (error) {
    throw new Error(`reference UI is missing accessible textbox "${checklistUi.edit(body)}"`, {
      cause: error,
    });
  }
  const save = page.getByRole("button", { name: checklistUi.save(body), exact: true }).first();
  try {
    await save.click();
  } catch (error) {
    throw new Error(`reference UI is missing accessible button "${checklistUi.save(body)}"`, {
      cause: error,
    });
  }
}

async function completeItem(page: Page, body: string): Promise<void> {
  const name = checklistUi.complete(body);
  const checkboxes = page.getByRole("checkbox", { name });
  try {
    await checkboxes.first().waitFor({ state: "visible" });
  } catch (error) {
    throw new Error(
      `reference UI needs checkbox "${checklistUi.complete(body)}"`,
      { cause: error },
    );
  }
  await checkboxes.first().click();
  await page.waitForFunction((accessibleName) => {
    const matches = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .filter((element) => element.getAttribute("aria-label") === accessibleName);
    return matches.length === 2 && matches.every((element) => element.checked);
  }, checklistUi.complete(body));
}

async function assertCompleted(page: Page, body: string): Promise<void> {
  const name = checklistUi.complete(body);
  const checkboxes = page.getByRole("checkbox", { name });
  await checkboxes.first().waitFor({ state: "visible" });
  assert(await checkboxes.count() === 2, `expected two completion controls for ${body}`);
  assert(
    await checkboxes.evaluateAll((elements) =>
      elements.every((element) => (element as HTMLInputElement).checked)
    ),
    `completion for ${body} did not survive reload in both islands`,
  );
}

async function deleteItem(page: Page, body: string): Promise<void> {
  const button = page.getByRole("button", { name: checklistUi.delete(body), exact: true }).first();
  try {
    await button.click();
  } catch (error) {
    throw new Error(`reference UI is missing accessible button "${checklistUi.delete(body)}"`, {
      cause: error,
    });
  }
}

async function waitForProductionPwa(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      return (globalThis as typeof globalThis & { __LOFI_PWA_STATE__?: string })
        .__LOFI_PWA_STATE__ === "ready";
    },
    undefined,
    { timeout: timeoutMs },
  );
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: timeoutMs,
  });
}

async function screenshotFailure(page: Page | null, path: string): Promise<void> {
  if (!page || page.isClosed()) return;
  try {
    await page.screenshot({ path, fullPage: true });
  } catch {
    // Process logs and the trace remain authoritative when the page itself is unavailable.
  }
}

function commandFailure(record: CommandRecord): Error {
  return new Error(
    `${record.name} failed with exit ${record.exitCode}; rerun ${Deno.execPath()} ${
      record.args.join(" ")
    } and inspect ${record.stderrPath}`,
  );
}

async function sourceRevision(
  sourceRoot: string,
  environment: Record<string, string>,
): Promise<string> {
  const output = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: sourceRoot,
    clearEnv: true,
    env: environment,
    stdout: "piped",
    stderr: "null",
  }).output();
  return output.success ? new TextDecoder().decode(output.stdout).trim() : "unavailable";
}

export async function runJourney(options: GoldenPathOptions): Promise<JourneyReport> {
  const sourceRoot = resolve(options.projectRoot ?? Deno.cwd());
  const environmentMode = options.environmentMode ?? "isolated-local";
  const artifacts = artifactPaths(
    resolve(
      options.artifactRoot ??
        join(
          sourceRoot,
          environmentMode === "cloud-from-root"
            ? "test-results/golden-path-cloud"
            : "test-results/golden-path",
        ),
    ),
  );
  await Deno.remove(artifacts.root, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.mkdir(artifacts.root, { recursive: true });

  const startedAt = new Date();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const commands = { ...defaultCommands, ...options.commands };
  const islandLabels = options.islandLabels ?? ["North island", "South island"];
  const environment = await journeyEnvironment(sourceRoot, environmentMode, artifacts.root);
  const redactValues = environmentNames.map((name) => environment[name]).filter(Boolean);
  const commit = await sourceRevision(sourceRoot, environment);
  const commandRecords: CommandRecord[] = [];
  const assertions: JourneyAssertion[] = [];
  let projectRoot = sourceRoot;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let dev: CapturedProcess | null = null;
  let preview: CapturedProcess | null = null;
  let browserVersion = "not launched";
  let devReadyMs: number | undefined;
  let firstRetainedWriteMs: number | undefined;
  let failure: unknown;

  const report: JourneyReport = {
    schemaVersion: 1,
    source: options.source,
    environmentMode: environmentMode === "cloud-from-root" ? "cloud-allowlisted" : "isolated-local",
    status: "failed",
    startedAt: startedAt.toISOString(),
    completedAt: startedAt.toISOString(),
    runtime: {
      deno: Deno.version.deno,
      typescript: Deno.version.typescript,
      v8: Deno.version.v8,
      os: Deno.build.os,
      arch: Deno.build.arch,
      browser: browserVersion,
      commit,
    },
    cacheMode: options.cacheMode ?? "existing",
    measurements: {
      developerCommandCount: 3,
    },
    commands: commandRecords,
    assertions,
    authorBoundaryViolations: [],
    artifacts,
  };

  try {
    if (options.source === "checkout") {
      projectRoot = await materializeCleanProject(sourceRoot);
      commandRecords.push(
        ...await initializeFixtureGit(projectRoot, environment, artifacts.root, redactValues),
      );
    }

    report.authorBoundaryViolations = await scanAuthorBoundary(
      projectRoot,
      options.authorPaths ?? defaultAuthorPaths,
    );
    assert(
      report.authorBoundaryViolations.length === 0,
      `author boundary leaked framework plumbing: ${
        report.authorBoundaryViolations.map((item) => `${item.path}:${item.line} ${item.rule}`)
          .join(
            ", ",
          )
      }`,
    );
    assertions.push({
      name: "author boundary",
      status: "passed",
      detail: "No forbidden runtime, worker, transport, Workbox, or capability plumbing found.",
    });

    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      throw new Error(
        "Chromium is unavailable; install the pinned browser through the repository's explicit Deno browser-install task.",
        { cause: error },
      );
    }
    browserVersion = browser.version();
    report.runtime.browser = browserVersion;
    context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();

    const port = reserveLocalPort();
    const devStarted = performance.now();
    dev = startReadyProcess({
      cwd: projectRoot,
      args: taskArgs(commands.dev, ["--host", "127.0.0.1", "--port", String(port)]),
      environment,
      artifactRoot: artifacts.root,
      name: "dev",
      readyPattern: /(http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?)/,
      readyCheck: probeHttpReady,
      timeoutMs,
      redactValues,
    });
    const devUrl = await dev.ready;
    devReadyMs = Math.round(performance.now() - devStarted);
    await page.goto(devUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.getByRole("textbox", { name: checklistUi.newItem }).first().waitFor({
      state: "visible",
    });
    await assertRuntimeCardinality(page, islandLabels);
    await page.getByRole("status").filter({ hasText: /\d+ item\(s\)/ }).first().waitFor({
      state: "visible",
    });
    devReadyMs = Math.round(performance.now() - devStarted);
    assertions.push({
      name: "development readiness",
      status: "passed",
      detail: `Hydrated author UI and the persistent runtime were usable in ${devReadyMs}ms.`,
    });

    await addItem(page, islandLabels[0], retainedBody);
    await waitForItem(page, islandLabels, retainedBody);
    await waitForLocalDurability(page);
    firstRetainedWriteMs = Math.round(performance.now() - devStarted);
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForItem(page, islandLabels, retainedBody);
    await assertRuntimeCardinality(page, islandLabels);
    assertions.push({
      name: "retained development write",
      status: "passed",
      detail:
        "The local write survived reload and both islands kept one shared runtime subscription.",
    });

    await updateItem(page, retainedBody, updatedBody);
    await waitForItem(page, islandLabels, updatedBody);
    await completeItem(page, updatedBody);
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForItem(page, islandLabels, updatedBody);
    await assertCompleted(page, updatedBody);

    await addItem(page, islandLabels[0], disposableBody);
    await waitForItem(page, islandLabels, disposableBody);
    await deleteItem(page, disposableBody);
    await waitForItemAbsent(page, islandLabels, disposableBody);
    assertions.push({
      name: "accessible CRUD",
      status: "passed",
      detail: "Create, update, complete, and delete worked through named author-facing controls.",
    });

    if (environmentMode === "cloud-from-root") await setReferenceConnection(page, false);
    await context.setOffline(true);
    await addItem(page, islandLabels[1], offlineDevelopmentBody);
    await waitForItem(page, islandLabels, offlineDevelopmentBody);
    await waitForLocalDurability(page);
    await context.setOffline(false);
    if (environmentMode === "cloud-from-root") await setReferenceConnection(page, true);
    assertions.push(
      await observeReconnectSettlement(page, timeoutMs, environmentMode === "cloud-from-root"),
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForItem(page, islandLabels, offlineDevelopmentBody);
    assertions.push({
      name: "development offline write",
      status: "passed",
      detail: "A loaded page accepted a local write offline and retained it after network return.",
    });

    await dev.stop();
    dev = null;
    for (
      const [name, task] of [
        ["check", commands.check],
        ["test", commands.test],
        ["build", commands.build],
      ] as const
    ) {
      const record = await runCapturedCommand({
        cwd: projectRoot,
        args: taskArgs(task),
        environment,
        artifactRoot: artifacts.root,
        name,
        redactValues,
      });
      commandRecords.push(record);
      if (record.exitCode !== 0) throw commandFailure(record);
    }
    assertions.push({
      name: "public verification commands",
      status: "passed",
      detail: "check, test, and build completed through Deno tasks.",
    });

    preview = startReadyProcess({
      cwd: projectRoot,
      args: taskArgs(commands.preview, ["--port", String(port)]),
      environment,
      artifactRoot: artifacts.root,
      name: "preview",
      readyPattern: /(http:\/\/127\.0\.0\.1:\d+\/)/,
      readyCheck: probeHttpReady,
      timeoutMs,
      redactValues,
    });
    const previewUrl = await preview.ready;
    assert(new URL(previewUrl).origin === new URL(devUrl).origin, "preview must reuse dev origin");
    await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForItem(page, islandLabels, updatedBody);
    await waitForProductionPwa(page, timeoutMs);
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForProductionPwa(page, timeoutMs);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForItem(page, islandLabels, updatedBody);
    await addItem(page, islandLabels[0], offlineProductionBody);
    await waitForItem(page, islandLabels, offlineProductionBody);
    await waitForLocalDurability(page);
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForItem(page, islandLabels, offlineProductionBody);
    await context.setOffline(false);
    if (environmentMode === "cloud-from-root") {
      await updateItem(page, offlineProductionBody, offlineProductionSyncedBody);
      await waitForItem(page, islandLabels, offlineProductionSyncedBody);
      assertions.push(await observeReconnectSettlement(page, timeoutMs, true));
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForItem(
      page,
      islandLabels,
      environmentMode === "cloud-from-root" ? offlineProductionSyncedBody : offlineProductionBody,
    );
    assertions.push({
      name: "production offline cold start",
      status: "passed",
      detail: "The service-worker shell and OPFS data survived cold offline reload and editing.",
    });

    if (environmentMode === "cloud-from-root") {
      for (const body of [updatedBody, offlineDevelopmentBody, offlineProductionSyncedBody]) {
        await deleteItem(page, body);
        await waitForItemAbsent(page, islandLabels, body);
        assertions.push(await observeReconnectSettlement(page, timeoutMs, true));
      }
      assertions.push({
        name: "cloud fixture cleanup",
        status: "passed",
        detail:
          "All golden-path rows were deleted through the public UI and the delete mutations reached global durability before the throwaway browser identity closed.",
      });
    }

    report.status = "passed";
  } catch (error) {
    failure = error;
    assertions.push({
      name: "golden journey",
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    await screenshotFailure(page, artifacts.screenshot);
  } finally {
    if (context) {
      await context.setOffline(false).catch(() => undefined);
      await context.tracing.stop({ path: artifacts.trace }).catch(() => undefined);
    }
    await preview?.stop().catch(() => undefined);
    await dev?.stop().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (options.source === "checkout" && projectRoot !== sourceRoot) {
      await Deno.remove(resolve(projectRoot, ".."), { recursive: true }).catch(() => {
        assertions.push({
          name: "clean checkout cleanup",
          status: "blocked",
          detail: `Temporary checkout cleanup failed for ${projectRoot}.`,
        });
      });
    }
    report.completedAt = new Date().toISOString();
    report.measurements.devReadyMs = devReadyMs;
    report.measurements.firstRetainedWriteMs = firstRetainedWriteMs;
    report.runtime.browser = browserVersion;
    await writeJourneyReport(report);
  }

  if (failure) throw failure;
  return report;
}
