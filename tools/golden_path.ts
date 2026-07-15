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
import { assert } from "./assert.ts";

export type GoldenPathCommands = {
  doctor?: string;
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
  hmrPath?: string;
  initialCommands?: CommandRecord[];
  sourceRevisionRoot?: string;
  resetArtifactRoot?: boolean;
  journeyStartedAt?: Date;
  journeyStartedPerformanceMs?: number;
  createDurationMs?: number;
  developerCommandCount?: number;
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
const replicaClearBody = "Golden path replica-clear disposable item";

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
  await textbox.fill(body);
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
  await page.waitForFunction(async () => {
    const inspector = (globalThis as typeof globalThis & {
      __LOFI_INSPECTOR__?: {
        readSnapshot(): Promise<{
          storage: { driver: string };
          runtime: {
            clients: number;
            consumers: number;
            vendorSubscriptions: number;
            mutationListeners: number;
          };
        }>;
      };
    }).__LOFI_INSPECTOR__;
    const snapshot = await inspector?.readSnapshot();
    return snapshot?.storage.driver === "persistent open" &&
      snapshot.runtime.clients === 1 &&
      snapshot.runtime.consumers === 2 &&
      snapshot.runtime.vendorSubscriptions === 1 &&
      snapshot.runtime.mutationListeners === 1;
  });
}

async function restartClientThroughInspector(
  page: Page,
  islandLabels: readonly string[],
  retainedItem: string,
  timeoutMs: number,
): Promise<void> {
  const before = await page.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    url: location.href,
    identity: JSON.stringify(
      Object.entries(localStorage).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }));
  const navigated = page.waitForEvent("domcontentloaded", { timeout: timeoutMs });
  await page.getByRole("button", { name: "Restart client" }).click();
  await navigated;
  const after = await page.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    url: location.href,
    identity: JSON.stringify(
      Object.entries(localStorage).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }));
  assert(after.timeOrigin !== before.timeOrigin, "inspector restart did not replace the document");
  assert(after.url === before.url, "inspector restart changed the application URL");
  assert(after.identity === before.identity, "inspector restart changed the device identity");
  await waitForItem(page, islandLabels, retainedItem);
  for (const label of islandLabels) {
    const island = page.locator("[data-island]").filter({ hasText: label });
    await island.getByRole("status").filter({ hasText: "1 item(s)" }).waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  }
  await assertRuntimeCardinality(page, islandLabels);
}

async function exerciseHmr(
  page: Page,
  projectRoot: string,
  hmrPath: string,
  islandLabels: readonly string[],
  retainedItem: string,
  timeoutMs: number,
): Promise<{ samples: number[]; restore: () => Promise<void> }> {
  const path = resolve(projectRoot, hmrPath);
  const original = await Deno.readTextFile(path);
  const samples: number[] = [];
  for (let cycle = 1; cycle <= 5; cycle++) {
    const started = performance.now();
    await Deno.writeTextFile(
      path,
      `${original}\n:root {\n  --lofi-golden-hmr-cycle: ${cycle};\n}\n`,
    );
    await page.waitForFunction(
      (expected) =>
        getComputedStyle(document.documentElement).getPropertyValue("--lofi-golden-hmr-cycle")
          .trim() === expected,
      String(cycle),
      { timeout: timeoutMs },
    );
    samples.push(Math.round(performance.now() - started));
    await waitForItem(page, islandLabels, retainedItem);
    await assertRuntimeCardinality(page, islandLabels);
  }
  return {
    samples,
    restore: async () => await Deno.writeTextFile(path, original),
  };
}

async function setReferenceConnection(page: Page, connected: boolean): Promise<void> {
  await page.evaluate(async (shouldConnect) => {
    const inspector = (globalThis as typeof globalThis & {
      __LOFI_INSPECTOR__?: { setTransportPaused(paused: boolean): Promise<void> };
    }).__LOFI_INSPECTOR__;
    if (!inspector) throw new Error("development inspector is unavailable");
    await inspector.setTransportPaused(!shouldConnect);
  }, connected);
}

async function exerciseReplicaClear(
  browser: Browser,
  url: string,
  islandLabels: readonly string[],
  timeoutMs: number,
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.getByRole("textbox", { name: checklistUi.newItem }).first().waitFor({
      state: "visible",
    });
    await assertRuntimeCardinality(page, islandLabels);
    await addItem(page, islandLabels[0], replicaClearBody);
    await waitForItem(page, islandLabels, replicaClearBody);
    await waitForLocalDurability(page);
    const identityBefore = await page.evaluate(() =>
      JSON.stringify(
        Object.entries(globalThis.localStorage).sort(([left], [right]) =>
          left.localeCompare(right)
        ),
      )
    );
    assert(identityBefore !== "[]", "replica-clear fixture did not create an identity state");
    const navigated = page.waitForEvent("domcontentloaded", { timeout: timeoutMs });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Clear local replica" }).click();
    await navigated;
    await waitForItemAbsent(page, islandLabels, replicaClearBody);
    const identityAfter = await page.evaluate(() =>
      JSON.stringify(
        Object.entries(globalThis.localStorage).sort(([left], [right]) =>
          left.localeCompare(right)
        ),
      )
    );
    assert(identityBefore === identityAfter, "replica clear changed the device-local identity");
  } finally {
    await context.close();
  }
}

async function inspectorMarkerFiles(root: string): Promise<string[]> {
  const matches: string[] = [];
  async function visit(path: string): Promise<void> {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory) await visit(child);
      else if (entry.isFile) {
        const content = await Deno.readTextFile(child).catch(() => "");
        if (content.includes("lofi-development-inspector")) matches.push(child);
      }
    }
  }
  await visit(root);
  return matches.sort();
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
  const revisionRoot = resolve(options.sourceRevisionRoot ?? sourceRoot);
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
  if (options.resetArtifactRoot !== false) {
    await Deno.remove(artifacts.root, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
  await Deno.mkdir(artifacts.root, { recursive: true });

  const startedAt = options.journeyStartedAt ?? new Date();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const commands = { ...defaultCommands, ...options.commands };
  const islandLabels = options.islandLabels ?? ["North island", "South island"];
  const environment = await journeyEnvironment(sourceRoot, environmentMode, artifacts.root);
  const redactValues = environmentNames.map((name) => environment[name]).filter(Boolean);
  const commit = await sourceRevision(revisionRoot, environment);
  const commandRecords: CommandRecord[] = [...options.initialCommands ?? []];
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
  let createToFirstRetainedWriteMs: number | undefined;
  let hmrMs: number[] | undefined;
  let restoreHmr: (() => Promise<void>) | null = null;
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
      developerCommandCount: options.developerCommandCount ?? (options.source === "create" ? 3 : 1),
      createMs: options.createDurationMs,
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

    if (commands.doctor) {
      const doctor = await runCapturedCommand({
        cwd: projectRoot,
        args: taskArgs(commands.doctor),
        environment,
        artifactRoot: artifacts.root,
        name: "doctor",
        redactValues,
      });
      commandRecords.push(doctor);
      if (doctor.exitCode !== 0) throw commandFailure(doctor);
      assertions.push({
        name: "doctor preflight",
        status: "passed",
        detail: "Generated diagnostics completed without starting the application.",
      });
    }

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
    const inspector = page.locator('[data-lofi-inspector="lofi-development-inspector"]');
    await inspector.waitFor({ state: "attached" });
    const inspectorSnapshot = await page.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & {
        __LOFI_INSPECTOR__?: { readSnapshot(): Promise<unknown> };
      }).__LOFI_INSPECTOR__;
      if (!bridge) throw new Error("development inspector bridge is unavailable");
      return await bridge.readSnapshot();
    });
    const serializedInspector = JSON.stringify(inspectorSnapshot);
    assert(
      serializedInspector.includes("live detail unavailable") ||
        serializedInspector.includes("not configured"),
      "inspector must name unavailable transport precision",
    );
    assert(
      !/secret|token|password/i.test(serializedInspector),
      "inspector snapshot exposed secrets",
    );
    if (environmentMode === "isolated-local") {
      assert(
        await page.getByRole("button", { name: "Transport pause unavailable in local-only" })
          .isDisabled(),
        "local-only inspector must disable cloud transport controls",
      );
    }
    assertions.push({
      name: "development inspector",
      status: "passed",
      detail:
        "The development-only surface exposed value-free storage, durability, runtime, and explicitly unavailable vendor signals.",
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
    if (options.journeyStartedPerformanceMs !== undefined) {
      createToFirstRetainedWriteMs = Math.round(
        performance.now() - options.journeyStartedPerformanceMs,
      );
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForItem(page, islandLabels, retainedBody);
    await assertRuntimeCardinality(page, islandLabels);
    assertions.push({
      name: "retained development write",
      status: "passed",
      detail:
        "The local write survived reload and both islands kept one shared runtime subscription.",
    });

    await restartClientThroughInspector(page, islandLabels, retainedBody, timeoutMs);
    assertions.push({
      name: "inspector client restart",
      status: "passed",
      detail: "The development-only client restart retained data and restored runtime cardinality.",
    });

    const hmr = await exerciseHmr(
      page,
      projectRoot,
      options.hmrPath ??
        (options.source === "create"
          ? "src/styles/global.css"
          : "apps/reference/src/styles/global.css"),
      islandLabels,
      retainedBody,
      timeoutMs,
    );
    hmrMs = hmr.samples;
    restoreHmr = hmr.restore;
    assertions.push({
      name: "HMR state and cardinality",
      status: "passed",
      detail:
        `Five observable style edits retained data with one client, two consumers, and one vendor subscription (${
          hmrMs.join(", ")
        }ms).`,
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

    if (environmentMode === "isolated-local") {
      await exerciseReplicaClear(browser, devUrl, islandLabels, timeoutMs);
      assertions.push({
        name: "inspector replica clear",
        status: "passed",
        detail:
          "A confirmation-gated clear removed an isolated OPFS replica while preserving its in-memory-compared identity state.",
      });
    }

    const devStderrPath = dev.stderrPath;
    await dev.stop();
    dev = null;
    const devStderr = await Deno.readTextFile(devStderrPath);
    assert(
      !devStderr.includes("error: development server stopped"),
      `normal development shutdown printed a fatal diagnostic; inspect ${devStderrPath}`,
    );
    assertions.push({
      name: "development shutdown",
      status: "passed",
      detail:
        "The generated development command stopped on the harness signal without a false failure.",
    });
    if (restoreHmr) await restoreHmr();
    restoreHmr = null;
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
    const productionRoot = join(
      projectRoot,
      options.source === "create" ? "dist" : "apps/reference/dist",
    );
    const inspectorFiles = await inspectorMarkerFiles(productionRoot);
    assert(
      inspectorFiles.length === 0,
      `production build contains development inspector markers: ${inspectorFiles.join(", ")}`,
    );
    assertions.push({
      name: "production inspector exclusion",
      status: "passed",
      detail: "The production bundle contains no development-inspector marker.",
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
    assert(
      await page.locator('[data-lofi-inspector="lofi-development-inspector"]').count() === 0,
      "production preview mounted the development inspector",
    );
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
    await restoreHmr?.().catch(() => undefined);
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
    report.measurements.createToFirstRetainedWriteMs = createToFirstRetainedWriteMs;
    report.measurements.hmrMs = hmrMs;
    if (hmrMs?.length) {
      const sorted = [...hmrMs].sort((left, right) => left - right);
      report.measurements.hmrMedianMs = sorted[Math.floor(sorted.length / 2)];
      report.measurements.hmrSlowestMs = sorted.at(-1);
    }
    report.runtime.browser = browserVersion;
    await writeJourneyReport(report);
  }

  if (failure) throw failure;
  return report;
}
