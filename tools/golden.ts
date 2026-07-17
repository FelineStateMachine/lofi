#!/usr/bin/env -S deno run -A

import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";
import { LOFI_VERSION } from "../package/version.ts";
import { waitForReady } from "../package/testing/readiness.ts";
import { redactDiagnosticText } from "../package/testing/safety.ts";
import { sanitizeTraceArchive } from "../package/testing/trace.ts";
import {
  type VirtualAuthenticatorCredential,
  withVirtualAuthenticator,
} from "../package/testing/webauthn.ts";

type PackageSource = "local" | "registry";
type StageLog = { command?: string; stdout: string; stderr: string };

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = join(repositoryRoot, "test-results", "golden");
const privateValues = ["golden-online-task", "golden-offline-task", "golden-synced-task"];
const logs = new Map<string, StageLog>();
const timings = new Map<string, number>();
let activeStage = "setup";

class GoldenStageError extends Error {
  override readonly name = "GoldenStageError";

  constructor(readonly stage: string, cause: unknown) {
    super(
      `golden stage ${JSON.stringify(stage)} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(args: readonly string[]): { source: PackageSource; version: string } {
  let source: PackageSource = "local";
  let version = LOFI_VERSION;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--source") {
      const value = args[++index];
      if (value !== "local" && value !== "registry") {
        throw new Error("--source must be local or registry");
      }
      source = value;
    } else if (argument === "--version") {
      version = args[++index] ?? "";
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error("--version must be an exact published semantic version");
      }
    } else {
      throw new Error(`unknown golden-runner argument ${JSON.stringify(argument)}`);
    }
  }
  if (source === "local" && version !== LOFI_VERSION) {
    throw new Error(`local source is workspace version ${LOFI_VERSION}, not ${version}`);
  }
  return { source, version };
}

async function stage<T>(name: string, action: () => Promise<T>): Promise<T> {
  activeStage = name;
  const started = performance.now();
  try {
    const value = await action();
    timings.set(name, Math.round(performance.now() - started));
    console.log(`golden ${name}: passed (${timings.get(name)}ms)`);
    return value;
  } catch (error) {
    throw error instanceof GoldenStageError ? error : new GoldenStageError(name, error);
  }
}

async function runCommand(
  stageName: string,
  command: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
  expectSuccess = true,
): Promise<Deno.CommandOutput> {
  const output = await new Deno.Command(command, {
    args: [...args],
    cwd,
    env: { ...environment },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  logs.set(stageName, { command: [command, ...args].join(" "), stdout, stderr });
  if (output.success !== expectSuccess) {
    throw new Error(
      `${basename(command)} ${args.join(" ")} ${
        expectSuccess ? "exited unsuccessfully" : "unexpectedly succeeded"
      }\n${stderr || stdout}`,
    );
  }
  return output;
}

function timeout<T>(promise: Promise<T>, milliseconds: number, description: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${description} timed out after ${milliseconds}ms`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class ManagedProcess {
  readonly child: Deno.ChildProcess;
  readonly status: Promise<Deno.CommandStatus>;
  #stdout = "";
  #stderr = "";
  #listeners = new Set<() => void>();

  constructor(
    readonly name: string,
    args: readonly string[],
    readonly cwd: string,
    environment: Readonly<Record<string, string>> = {},
  ) {
    this.child = new Deno.Command(Deno.execPath(), {
      args: [...args],
      cwd,
      env: { ...environment },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.status = this.child.status;
    void this.#consume(this.child.stdout, "stdout");
    void this.#consume(this.child.stderr, "stderr");
  }

  get output(): StageLog {
    return { command: `deno (${this.name})`, stdout: this.#stdout, stderr: this.#stderr };
  }

  async #consume(stream: ReadableStream<Uint8Array>, destination: "stdout" | "stderr") {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      if (destination === "stdout") this.#stdout += text;
      else this.#stderr += text;
      for (const listener of this.#listeners) listener();
    }
  }

  waitForOutput(pattern: RegExp, milliseconds = 30_000): Promise<void> {
    return timeout(
      new Promise<void>((resolveReady, reject) => {
        const inspect = () => {
          if (!pattern.test(`${this.#stdout}\n${this.#stderr}`)) return;
          this.#listeners.delete(inspect);
          resolveReady();
        };
        this.#listeners.add(inspect);
        inspect();
        void this.status.then((status) => {
          if (this.#listeners.delete(inspect)) {
            reject(
              new Error(
                `${this.name} exited with code ${status.code} before readiness\n${this.#stderr}`,
              ),
            );
          }
        });
      }),
      milliseconds,
      `${this.name} readiness`,
    );
  }

  async stop(): Promise<void> {
    try {
      this.child.kill("SIGTERM");
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        logs.set(this.name, this.output);
        return;
      }
      throw error;
    }
    try {
      await timeout(this.status, 8_000, `${this.name} graceful shutdown`);
    } catch {
      try {
        this.child.kill("SIGKILL");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await timeout(this.status, 5_000, `${this.name} forced termination`);
    } finally {
      logs.set(this.name, this.output);
    }
  }
}

async function configureGoldenSync(projectRoot: string) {
  const server = await startLocalJazzServer({ allowLocalFirstAuth: true });
  const cacheBuster = `?golden=${Date.now()}`;
  const [{ app }, { default: permissions }] = await Promise.all([
    import(`${pathToFileURL(join(projectRoot, "src", "schema.ts")).href}${cacheBuster}`),
    import(`${pathToFileURL(join(projectRoot, "src", "permissions.ts")).href}${cacheBuster}`),
  ]);
  await deploy({
    appId: server.appId,
    serverUrl: server.url,
    adminSecret: server.adminSecret,
    schema: app,
    permissions,
  });
  return server;
}

function allocatePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function waitForListening(process: ManagedProcess, port: number): Promise<void> {
  return timeout(
    new Promise<void>((resolveReady, reject) => {
      let active = true;
      const attempt = async () => {
        if (!active) return;
        try {
          const connection = await Deno.connect({ hostname: "127.0.0.1", port });
          connection.close();
          active = false;
          resolveReady();
        } catch {
          if (active) setTimeout(() => void attempt(), 20);
        }
      };
      void process.status.then((status) => {
        if (!active) return;
        active = false;
        reject(
          new Error(`${process.name} exited with code ${status.code} before accepting connections`),
        );
      });
      void attempt();
    }),
    30_000,
    `${process.name} listening on allocated port`,
  );
}

async function waitForRegistryVersion(version: string): Promise<void> {
  let lastError = "version not visible";
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const response = await fetch("https://jsr.io/@nzip/lofi/meta.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`JSR metadata returned ${response.status}`);
      const metadata = await response.json() as { versions?: Record<string, unknown> };
      if (metadata.versions && version in metadata.versions) return;
      lastError = `@nzip/lofi@${version} is not in JSR metadata`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 12) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
  throw new Error(`registry availability retry exhausted: ${lastError}`);
}

async function generateProject(
  source: PackageSource,
  version: string,
  temporaryRoot: string,
): Promise<string> {
  if (source === "registry") await waitForRegistryVersion(version);
  const projectName = "golden-app";
  const args = source === "registry"
    ? ["run", "-A", `jsr:@nzip/lofi@${version}/create`, projectName]
    : ["run", "-A", join(repositoryRoot, "package", "create.ts"), projectName];
  const environment: Record<string, string> = source === "local"
    ? {
      LOFI_CREATE_DEVELOPMENT: "1",
      LOFI_CREATE_PACKAGE_PREFIX: `${pathToFileURL(join(repositoryRoot, "package")).href}/`,
    }
    : {};
  const output = await runCommand("create", Deno.execPath(), args, temporaryRoot, environment);
  const stdout = new TextDecoder().decode(output.stdout).replaceAll("\r\n", "\n");
  assert(
    stdout.includes("Next:\n  cd golden-app\n  deno task dev\n"),
    "generator did not print the exact next commands",
  );
  const projectRoot = join(temporaryRoot, projectName);
  const marker = join(projectRoot, "golden-do-not-overwrite.txt");
  await Deno.writeTextFile(marker, "preserved\n");
  const refusal = await runCommand(
    "create-refusal",
    Deno.execPath(),
    args,
    temporaryRoot,
    environment,
    false,
  );
  const refusalOutput = `${new TextDecoder().decode(refusal.stdout)}\n${
    new TextDecoder().decode(refusal.stderr)
  }`;
  assert(
    refusalOutput.includes("already exists and is not empty"),
    "generator refusal was not actionable",
  );
  assert(
    await Deno.readTextFile(marker) === "preserved\n",
    "generator overwrote a non-empty project",
  );
  await Deno.remove(marker);
  return projectRoot;
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix = "") {
    for await (const entry of Deno.readDir(directory)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) await visit(join(directory, entry.name), relative);
      else if (entry.isFile) files.push(relative);
    }
  }
  await visit(root);
  return files.sort();
}

async function assertGeneratedBoundary(
  projectRoot: string,
  source: PackageSource,
  version: string,
) {
  for (const forbidden of ["src/_lofi", "public/sw.js", "astro.config.ts"]) {
    try {
      await Deno.stat(join(projectRoot, forbidden));
      throw new Error(`generated project contains forbidden ${forbidden}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const config = JSON.parse(await Deno.readTextFile(join(projectRoot, "deno.json"))) as {
    imports: Record<string, string>;
  };
  const lofiImports = Object.entries(config.imports).filter(([name]) =>
    name === "@nzip/lofi" || name.startsWith("@nzip/lofi/")
  );
  assert(lofiImports.length === 12, `expected 12 lofi imports, received ${lofiImports.length}`);
  const expected = source === "registry"
    ? `jsr:@nzip/lofi@${version}`
    : pathToFileURL(join(repositoryRoot, "package")).href;
  assert(
    lofiImports.every(([, target]) => target.startsWith(expected)),
    `generated imports do not resolve through exactly one ${source} package ${version}`,
  );
  for (
    const icon of [
      "public/apple-touch-icon.png",
      "public/icon-192.png",
      "public/icon-512.png",
      "public/icon-maskable-512.png",
    ]
  ) await Deno.stat(join(projectRoot, icon));
}

function pngDimensions(bytes: Uint8Array): [number, number] {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  assert(signature.every((byte, index) => bytes[index] === byte), "icon is not PNG data");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

async function assertProductionOutput(projectRoot: string) {
  const dist = join(projectRoot, "dist");
  const files = await filesUnder(dist);
  for (
    const required of [
      "index.html",
      "manifest.webmanifest",
      "sw.js",
      "lofi-precache.json",
      "apple-touch-icon.png",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-512.png",
    ]
  ) assert(files.includes(required), `production output is missing ${required}`);

  const manifest = JSON.parse(await Deno.readTextFile(join(dist, "manifest.webmanifest"))) as {
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  };
  const expected = new Map([
    ["icon-192.png", [192, "any"] as const],
    ["icon-512.png", [512, "any"] as const],
    ["icon-maskable-512.png", [512, "maskable"] as const],
  ]);
  for (const icon of manifest.icons) {
    const file = basename(icon.src);
    const contract = expected.get(file);
    assert(contract, `manifest references unexpected ${file}`);
    assert(icon.type === "image/png", `${file} has incorrect manifest type`);
    assert(icon.sizes === `${contract[0]}x${contract[0]}`, `${file} has incorrect manifest size`);
    assert(icon.purpose === contract[1], `${file} has incorrect manifest purpose`);
    const [width, height] = pngDimensions(await Deno.readFile(join(dist, file)));
    assert(width === contract[0] && height === contract[0], `${file} dimensions are incorrect`);
  }
  assert(manifest.icons.length === expected.size, "manifest does not contain the exact icon set");
  const [appleWidth, appleHeight] = pngDimensions(
    await Deno.readFile(join(dist, "apple-touch-icon.png")),
  );
  assert(appleWidth === 180 && appleHeight === 180, "iOS icon is not 180x180");

  const precache = JSON.parse(
    await Deno.readTextFile(join(dist, "lofi-precache.json")),
  ) as string[];
  for (
    const shellAsset of [
      "./",
      "./manifest.webmanifest",
      "./apple-touch-icon.png",
      "./icon-192.png",
      "./icon-512.png",
      "./icon-maskable-512.png",
    ]
  ) assert(precache.includes(shellAsset), `precache is missing ${shellAsset}`);
  const worker = await Deno.readTextFile(join(dist, "sw.js"));
  assert(
    !worker.includes("__LOFI_BUILD_REVISION__"),
    "service worker build revision was not replaced",
  );
  const html = await Deno.readTextFile(join(dist, "index.html"));
  assert(html.includes("apple-touch-icon.png"), "production shell omitted the iOS icon");

  const forbidden = [
    "lofi-development-inspector",
    "__LOFI_INSPECTOR__",
    "__LOFI_TEST_PROBE__",
    "data-lofi-test-probe",
  ];
  for (const file of files) {
    if (!/\.(?:css|html|js|json|map|svg|webmanifest)$/.test(file)) continue;
    const contents = await Deno.readTextFile(join(dist, file));
    for (const marker of forbidden) {
      assert(!contents.includes(marker), `production output ${file} contains ${marker}`);
    }
  }
}

async function captureFailure(
  error: unknown,
  projectRoot: string | undefined,
  page: Page | undefined,
  context: BrowserContext | undefined,
  browserDiagnostics: readonly string[],
) {
  const stageName = error instanceof GoldenStageError ? error.stage : activeStage;
  const directory = join(artifactsRoot, stageName.replaceAll(/[^a-z0-9._-]+/gi, "-"));
  await Deno.mkdir(directory, { recursive: true });
  const redact = (value: string) =>
    redactDiagnosticText(value, [
      ...privateValues,
      ...(projectRoot ? [projectRoot, dirname(projectRoot)] : []),
    ]);
  if (page && !page.isClosed()) {
    await page.screenshot({
      path: join(directory, "page.png"),
      fullPage: true,
      mask: [page.locator("#new-task"), page.locator(".task")],
    }).catch(() => undefined);
  }
  if (context) {
    const trace = join(directory, "browser.trace.zip");
    try {
      await context.tracing.stop({ path: trace });
      await sanitizeTraceArchive(trace, redact);
    } catch {
      await Deno.remove(trace).catch(() => undefined);
    }
  }
  for (const [name, log] of logs) {
    const content = [log.command ? `$ ${log.command}` : "", log.stdout, log.stderr]
      .filter(Boolean)
      .join("\n");
    await Deno.writeTextFile(join(directory, `${name}.log`), `${redact(content)}\n`);
  }
  await Deno.writeTextFile(
    join(directory, "browser.log"),
    `${browserDiagnostics.map(redact).join("\n")}\n`,
  );
  await Deno.writeTextFile(
    join(directory, "error.log"),
    `${redact(error instanceof Error ? error.stack ?? error.message : String(error))}\n`,
  );
  console.error(`golden failure artifacts: ${directory}`);
}

const taskAppReady = () => {
  const status = document.querySelector('[role="status"]');
  return status !== null && /item\(s\)/.test(status.textContent ?? "");
};

async function selectVirtualCredential(page: Page, credentialId: string): Promise<void> {
  await page.evaluate((encodedId) => {
    const normalized = encodedId.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const credentials = navigator.credentials;
    const original = credentials.get.bind(credentials);
    Object.defineProperty(credentials, "preventSilentAccess", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    Object.defineProperty(credentials, "get", {
      configurable: true,
      value: (options?: CredentialRequestOptions) => {
        if (!options?.publicKey) return original(options);
        return original({
          ...options,
          publicKey: {
            ...options.publicKey,
            allowCredentials: [{ id: bytes, type: "public-key", transports: ["internal"] }],
          },
        });
      },
    });
  }, credentialId);
}

async function main() {
  const { source, version } = parseArgs(Deno.args);
  await Deno.remove(artifactsRoot, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  const temporaryRoot = await Deno.makeTempDir({ prefix: "lofi-golden-" });
  const port = allocatePort();
  // `localhost` is a valid WebAuthn RP-ID; an IP address is not portable across
  // authenticators even though Chromium treats it as a secure context.
  const origin = `http://localhost:${port}/`;
  let projectRoot: string | undefined;
  let dev: ManagedProcess | undefined;
  let preview: ManagedProcess | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let syncServer: Awaited<ReturnType<typeof startLocalJazzServer>> | undefined;
  let recoveryCredential: VirtualAuthenticatorCredential | undefined;
  let recoveryPhrase = "";
  let restoredIdentity = "";
  const browserDiagnostics: string[] = [];
  try {
    projectRoot = await stage("create", () => generateProject(source, version, temporaryRoot));
    await stage("generated boundary", () => assertGeneratedBoundary(projectRoot!, source, version));
    await stage(
      "doctor",
      () =>
        runCommand("doctor", Deno.execPath(), ["task", "doctor"], projectRoot!).then(() =>
          undefined
        ),
    );
    await stage(
      "test",
      () =>
        runCommand("test", Deno.execPath(), ["task", "test"], projectRoot!).then(() => undefined),
    );

    syncServer = await stage("managed sync", () => configureGoldenSync(projectRoot!));
    const syncEnvironment = {
      JAZZ_APP_ID: syncServer.appId,
      JAZZ_SERVER_URL: syncServer.url,
    };

    dev = new ManagedProcess(
      "dev",
      [
        "task",
        "dev",
        "--",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      projectRoot,
      syncEnvironment,
    );
    await stage(
      "development readiness",
      async () => {
        await dev!.waitForOutput(new RegExp(`http://127\\.0\\.0\\.1:${port}/`));
        await waitForListening(dev!, port);
      },
    );
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    page = await context.newPage();
    const profileAAuthenticator = await withVirtualAuthenticator(page);
    page.on(
      "console",
      (message) => browserDiagnostics.push(`console ${message.type()}: ${message.text()}`),
    );
    page.on(
      "pageerror",
      (error) => browserDiagnostics.push(`pageerror: ${error.name}: ${error.message}`),
    );
    page.on(
      "requestfailed",
      (request) =>
        browserDiagnostics.push(
          `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
        ),
    );
    await stage("development browser", async () => {
      await page!.goto(origin, { waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "generated task app local store",
        timeoutMs: 30_000,
      });
      await page!.fill("#new-task", privateValues[0]);
      await page!.press("#new-task", "Enter");
      await page!.locator(".task", { hasText: privateValues[0] }).waitFor({ state: "visible" });
      await page!.reload({ waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "task app after full reload",
      });
      await page!.locator(".task", { hasText: privateValues[0] }).waitFor({ state: "visible" });
      const worker = await page!.evaluate(() =>
        (globalThis as typeof globalThis & { __LOFI_PWA_STATE__?: { worker?: string } })
          .__LOFI_PWA_STATE__?.worker
      );
      assert(worker === "development-disabled", `development worker state was ${worker}`);
    });
    await stage("passkey backup", async () => {
      await page!.getByRole("button", { name: "Back up & enable sync" }).click();
      await page!.getByRole("heading", { name: "Backed up & syncing" }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      await page!.getByRole("button", { name: "Show recovery phrase" }).click();
      await page!.locator(".account-words").waitFor({ state: "visible" });
      recoveryPhrase = (await page!.locator(".account-words li").allTextContents()).join(" ");
      assert(recoveryPhrase.split(" ").length === 24, "backup did not reveal a 24-word phrase");
      privateValues.push(recoveryPhrase);
      restoredIdentity = (await page!.locator("[data-sharing-identity]").textContent())?.trim() ??
        "";
      assert(restoredIdentity.startsWith("lofi1:"), "profile A did not expose a sharing identity");
      const credentials = await profileAAuthenticator.credentials();
      assert(
        credentials.length === 1,
        `expected one recoverable passkey, received ${credentials.length}`,
      );
      recoveryCredential = credentials[0];
      await waitForReady(page!, taskAppReady, undefined, {
        description: "task store after sync runtime recreation",
        timeoutMs: 30_000,
      });
      await page!.fill("#new-task", privateValues[2]);
      await page!.press("#new-task", "Enter");
      await page!.locator(".task", { hasText: privateValues[2] }).waitFor({ state: "visible" });
    });
    await profileAAuthenticator.dispose();

    await stage("two-profile passkey restore", async () => {
      const profileBBrowser = await chromium.launch({ headless: true });
      const profileB = await profileBBrowser.newContext();
      const profileBPage = await profileB.newPage();
      const profileBAuthenticator = await withVirtualAuthenticator(profileBPage);
      try {
        await profileBPage.goto(origin, { waitUntil: "domcontentloaded" });
        await waitForReady(profileBPage, taskAppReady, undefined, {
          description: "fresh profile B local account",
          timeoutMs: 30_000,
        });
        await profileBAuthenticator.addCredential(recoveryCredential!);
        assert(
          (await profileBAuthenticator.credentials()).length === 1,
          "profile B virtual authenticator did not retain the recovery credential",
        );
        await selectVirtualCredential(profileBPage, recoveryCredential!.credentialId);
        await profileBPage.getByRole("checkbox", { name: /I understand restore replaces/ }).check();
        await profileBPage.getByRole("button", { name: "Use passkey" }).click();
        try {
          await profileBPage.getByRole("heading", { name: "Backed up & syncing" }).waitFor({
            state: "visible",
            timeout: 5_000,
          });
        } catch (cause) {
          const accountText = await profileBPage.locator(".account").innerText().catch(() => "");
          const elected = await profileBPage.evaluate(() =>
            Object.entries(localStorage).some(([key, value]) =>
              key.startsWith("lofi:sync-elected:") && value === "1"
            )
          );
          throw new Error(
            `profile B did not complete passkey restore (sync elected: ${elected}): ${accountText}`,
            { cause },
          );
        }
        const identityB = (await profileBPage.locator("[data-sharing-identity]").textContent())
          ?.trim() ?? "";
        assert(
          identityB === restoredIdentity,
          "passkey restore opened a different session.user_id",
        );
        await waitForReady(profileBPage, taskAppReady, undefined, {
          description: "profile B restored task store",
          timeoutMs: 30_000,
        });
        await profileBPage.locator(".task", { hasText: privateValues[2] }).waitFor({
          state: "visible",
          timeout: 30_000,
        });
        await profileBPage.locator(".task", { hasText: privateValues[0] }).waitFor({
          state: "visible",
          timeout: 30_000,
        });
      } finally {
        await profileBAuthenticator.dispose().catch(() => undefined);
        await profileB.close();
        await profileBBrowser.close();
      }
    });

    await stage("phrase fallback after unavailable passkey", async () => {
      const profileCBrowser = await chromium.launch({ headless: true });
      const profileC = await profileCBrowser.newContext();
      await profileC.addInitScript(() => {
        Object.defineProperty(navigator, "credentials", { configurable: true, value: undefined });
      });
      const profileCPage = await profileC.newPage();
      try {
        await profileCPage.goto(origin, { waitUntil: "domcontentloaded" });
        await waitForReady(profileCPage, taskAppReady, undefined, {
          description: "fresh profile C local account",
          timeoutMs: 30_000,
        });
        await profileCPage.getByRole("checkbox", { name: /I understand restore replaces/ }).check();
        await profileCPage.getByRole("button", { name: "Use passkey" }).click();
        await profileCPage.locator("#recovery-input").waitFor({
          state: "visible",
          timeout: 10_000,
        });
        await profileCPage.fill("#recovery-input", recoveryPhrase);
        await profileCPage.getByRole("button", { name: "Restore account" }).click();
        await profileCPage.getByRole("heading", { name: "Backed up & syncing" }).waitFor({
          state: "visible",
          timeout: 30_000,
        });
        const identityC = (await profileCPage.locator("[data-sharing-identity]").textContent())
          ?.trim() ?? "";
        assert(
          identityC === restoredIdentity,
          "phrase fallback opened a different session.user_id",
        );
      } finally {
        await profileC.close();
        await profileCBrowser.close();
      }
    });
    await stage("return to local-only", async () => {
      await page!.getByRole("button", { name: "Stop syncing" }).click();
      await page!.getByRole("heading", { name: "Back up & sync" }).waitFor({ state: "visible" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "task store after returning local-only",
        timeoutMs: 30_000,
      });
      await page!.locator(".task", { hasText: privateValues[2] }).waitFor({ state: "visible" });
    });
    await stage("development shutdown", () => dev!.stop());
    dev = undefined;

    await stage(
      "build",
      () =>
        runCommand(
          "build",
          Deno.execPath(),
          ["task", "build"],
          projectRoot!,
          syncEnvironment,
        ).then(() => undefined),
    );
    await stage("production output", () => assertProductionOutput(projectRoot!));
    preview = new ManagedProcess(
      "preview",
      ["task", "preview", "--port", String(port)],
      projectRoot,
    );
    await stage(
      "preview readiness",
      async () => {
        await preview!.waitForOutput(
          new RegExp(`lofi preview: http://127\\.0\\.0\\.1:${port}/`),
        );
        await waitForListening(preview!, port);
      },
    );
    await stage("production offline browser", async () => {
      await page!.goto(origin, { waitUntil: "domcontentloaded" });
      await waitForReady(
        page!,
        () => {
          const global = globalThis as typeof globalThis & {
            __LOFI_PWA_STATE__?: { worker?: string };
          };
          return global.__LOFI_PWA_STATE__?.worker === "ready";
        },
        undefined,
        { description: "production service worker ready", timeoutMs: 30_000 },
      );
      await waitForReady(page!, taskAppReady, undefined, {
        description: "production task app ready",
      });
      const shellCached = await page!.evaluate(async () =>
        Boolean(await caches.match(new URL("./", location.href)))
      );
      assert(shellCached, "service-worker precache does not contain the app shell");
      await context!.setOffline(true);
      await page!.reload({ waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "offline cold page ready",
      });
      await page!.locator(".task", { hasText: privateValues[2] }).waitFor({ state: "visible" });
      await page!.fill("#new-task", privateValues[1]);
      await page!.press("#new-task", "Enter");
      await page!.locator(".task", { hasText: privateValues[1] }).waitFor({ state: "visible" });
      await page!.reload({ waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, { description: "offline task persisted" });
      await page!.locator(".task", { hasText: privateValues[1] }).waitFor({ state: "visible" });
      await context!.setOffline(false);
      await waitForReady(
        page!,
        () => {
          const syncLabel = [...document.querySelectorAll("dt")].find((node) =>
            node.textContent?.trim() === "Sync"
          );
          const taskStatus = document.querySelector('[role="status"]')?.textContent ?? "";
          return /item\(s\)/.test(taskStatus) &&
            syncLabel?.nextElementSibling?.textContent?.trim() === "available — not yet backed up";
        },
        undefined,
        { description: "public local-only durability and sync state" },
      );
      const state = await page!.evaluate(() => {
        const syncLabel = [...document.querySelectorAll("dt")].find((node) =>
          node.textContent?.trim() === "Sync"
        );
        return {
          worker: (globalThis as typeof globalThis & { __LOFI_PWA_STATE__?: { worker?: string } })
            .__LOFI_PWA_STATE__?.worker,
          status: document.querySelector('[role="status"]')?.textContent ?? "",
          sync: syncLabel?.nextElementSibling?.textContent?.trim() ?? "",
        };
      });
      assert(state.worker === "ready", `production service worker ended in ${state.worker}`);
      assert(/item\(s\)/.test(state.status), "public retained-row state is missing");
      assert(
        state.sync === "available — not yet backed up",
        `unexpected public sync state ${state.sync}`,
      );
    });
    await context.tracing.stop();
    await stage("preview shutdown", () => preview!.stop());
    preview = undefined;
    console.log(
      `golden result: ${source} @nzip/lofi ${version} passed on allocated origin ${origin}`,
    );
    console.log(
      `golden timings: ${
        [...timings].map(([name, milliseconds]) => `${name}=${milliseconds}ms`).join(", ")
      }`,
    );
  } catch (error) {
    await Promise.allSettled([dev?.stop(), preview?.stop()]);
    dev = undefined;
    preview = undefined;
    await captureFailure(error, projectRoot, page, context, browserDiagnostics);
    throw error;
  } finally {
    await Promise.allSettled([dev?.stop(), preview?.stop()]);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await syncServer?.stop().catch(() => undefined);
    await Deno.remove(temporaryRoot, { recursive: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
