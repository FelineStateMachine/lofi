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
    ? [
      "run",
      "-A",
      "--minimum-dependency-age=0",
      `jsr:@nzip/lofi@${version}/create`,
      projectName,
    ]
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
  if (source === "registry") {
    const config = JSON.parse(await Deno.readTextFile(join(projectRoot, "deno.json"))) as {
      imports: Record<string, string>;
    };
    const packageEntrypoints = [
      ...new Set(
        Object.entries(config.imports)
          .filter(([name]) =>
            name === "@nzip/lofi" || name.startsWith("@nzip/lofi/") &&
              !name.endsWith("/")
          )
          .map(([, target]) => target),
      ),
    ];
    await runCommand(
      "registry-cache",
      Deno.execPath(),
      ["cache", "--minimum-dependency-age=0", ...packageEntrypoints],
      projectRoot,
    );
  }
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
  assert(lofiImports.length === 20, `expected 20 lofi imports, received ${lofiImports.length}`);
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
      "launch/index.html",
      "share/index.html",
      "manifest.webmanifest",
      "sw.js",
      "lofi-precache.json",
      "apple-touch-icon.png",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-512.png",
      "screenshot-narrow.png",
      "screenshot-wide.png",
    ]
  ) assert(files.includes(required), `production output is missing ${required}`);

  const manifest = JSON.parse(await Deno.readTextFile(join(dist, "manifest.webmanifest"))) as {
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
    screenshots: Array<{
      src: string;
      sizes: string;
      type: string;
      form_factor: string;
      label: string;
    }>;
    share_target: {
      action: string;
      method: string;
      enctype: string;
      params: { title: string; text: string; url: string };
    };
    launch_handler: { client_mode: string[] };
  };
  assert(manifest.share_target.action === "./share/", "share target action drifted");
  assert(manifest.share_target.method === "GET", "share target method drifted");
  assert(
    manifest.launch_handler.client_mode.join(",") === "focus-existing,auto",
    "launch handler client mode drifted",
  );
  const expected = new Map([
    [
      "icon-192.png",
      { sizes: "192x192", type: "image/png", purpose: "any", dimensions: 192 } as const,
    ],
    [
      "icon-512.png",
      { sizes: "512x512", type: "image/png", purpose: "any", dimensions: 512 } as const,
    ],
    [
      "icon-maskable-512.png",
      { sizes: "512x512", type: "image/png", purpose: "maskable", dimensions: 512 } as const,
    ],
    [
      "icon-monochrome.svg",
      { sizes: "any", type: "image/svg+xml", purpose: "monochrome" } as const,
    ],
  ]);
  for (const icon of manifest.icons) {
    const file = basename(icon.src);
    const contract = expected.get(file);
    assert(contract, `manifest references unexpected ${file}`);
    assert(icon.type === contract.type, `${file} has incorrect manifest type`);
    assert(icon.sizes === contract.sizes, `${file} has incorrect manifest size`);
    assert(icon.purpose === contract.purpose, `${file} has incorrect manifest purpose`);
    await Deno.stat(join(dist, file));
    if ("dimensions" in contract) {
      const [width, height] = pngDimensions(await Deno.readFile(join(dist, file)));
      assert(
        width === contract.dimensions && height === contract.dimensions,
        `${file} dimensions are incorrect`,
      );
    }
  }
  assert(manifest.icons.length === expected.size, "manifest does not contain the exact icon set");
  const screenshots = new Map([
    ["narrow", ["screenshot-narrow.png", 540, 720] as const],
    ["wide", ["screenshot-wide.png", 1280, 720] as const],
  ]);
  for (const screenshot of manifest.screenshots) {
    const contract = screenshots.get(screenshot.form_factor);
    assert(contract, `manifest references unexpected ${screenshot.form_factor} screenshot`);
    const file = basename(screenshot.src);
    assert(file === contract[0], `${screenshot.form_factor} screenshot file drifted`);
    assert(screenshot.type === "image/png", `${file} has incorrect manifest type`);
    assert(screenshot.sizes === `${contract[1]}x${contract[2]}`, `${file} size drifted`);
    assert(screenshot.label.trim().length > 0, `${file} has no label`);
    const [width, height] = pngDimensions(await Deno.readFile(join(dist, file)));
    assert(width === contract[1] && height === contract[2], `${file} dimensions are incorrect`);
  }
  assert(manifest.screenshots.length === screenshots.size, "manifest screenshot set is incomplete");
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
  for (const screenshot of ["screenshot-narrow.png", "screenshot-wide.png"]) {
    assert(!precache.includes(`./${screenshot}`), `${screenshot} leaked into the required shell`);
  }
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

// Every golden-recipe installer patches the same authored manifest; one
// helper owns the read/patch/write cycle so the seven installers cannot
// drift in how they load or serialize it.
async function patchManifest(
  projectRoot: string,
  // deno-lint-ignore no-explicit-any
  patch: (manifest: any) => void,
): Promise<void> {
  const manifestPath = join(projectRoot, "public", "manifest.webmanifest");
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
  patch(manifest);
  await Deno.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function installWebShareRecipe(projectRoot: string) {
  await patchManifest(projectRoot, (manifest) => {
    manifest.share_target = {
      action: "./share/",
      method: "GET",
      enctype: "application/x-www-form-urlencoded",
      params: { title: "title", text: "text", url: "url" },
    };
  });
  await Deno.writeTextFile(
    join(projectRoot, "src", "pages", "share.astro"),
    `---
import ShareReceiver from "../islands/ShareReceiver.tsx";
import Shell from "../layouts/Shell.astro";
import "../styles/global.css";
---

<Shell title="Review shared content">
  <ShareReceiver client:load />
</Shell>
`,
  );
  await Deno.writeTextFile(
    join(projectRoot, "src", "islands", "ShareReceiver.tsx"),
    `import { useEffect, useState } from "preact/hooks";
import {
  parseTextShareTarget,
  shareOrFallback,
  type TextShareTargetResult,
  type WebShareOutcome,
} from "@nzip/lofi/recipes/web-share";

export default function ShareReceiver() {
  const [result, setResult] = useState<TextShareTargetResult>();
  const [confirmed, setConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<WebShareOutcome>();

  useEffect(() => setResult(parseTextShareTarget(location.search)), []);
  if (!result) return <p role="status">Opening shared draft…</p>;
  if (!result.ok) return <p role="alert">This shared content is not valid.</p>;
  const draft = result.draft;
  return (
    <section class="island" data-share-draft>
      <h1>Review shared content</h1>
      {draft.title && <p data-share-title>{draft.title}</p>}
      {draft.text && <p data-share-text>{draft.text}</p>}
      {draft.url && <a data-share-url href={draft.url}>{draft.url}</a>}
      <button type="button" onClick={() => setConfirmed(true)}>Add to app</button>
      {confirmed && <p role="status">Draft confirmed.</p>}
      <button
        type="button"
        onClick={() => void shareOrFallback(draft, {
          fallback: () => setOutcome("fallback"),
        }).then(setOutcome)}
      >
        Share this draft
      </button>
      {outcome && <output data-share-outcome>{outcome}</output>}
    </section>
  );
}
`,
  );
}

async function installLaunchHandlerRecipe(projectRoot: string) {
  await patchManifest(projectRoot, (manifest) => {
    manifest.launch_handler = { client_mode: ["focus-existing", "auto"] };
  });
  await Deno.writeTextFile(
    join(projectRoot, "src", "pages", "launch.astro"),
    `---
import LaunchReceiver from "../islands/LaunchReceiver.tsx";
import Shell from "../layouts/Shell.astro";
import "../styles/global.css";
---

<Shell title="Installed app launch">
  <LaunchReceiver client:load />
</Shell>
`,
  );
  await Deno.writeTextFile(
    join(projectRoot, "src", "islands", "LaunchReceiver.tsx"),
    `import { useEffect, useState } from "preact/hooks";
import {
  installInstalledAppLaunchConsumer,
  type InstalledAppLaunchIssue,
} from "@nzip/lofi/recipes/launch-handler";

export default function LaunchReceiver() {
  const [supported, setSupported] = useState<boolean>();
  const [target, setTarget] = useState("");
  const [issue, setIssue] = useState<InstalledAppLaunchIssue>();
  useEffect(() => {
    const consumer = installInstalledAppLaunchConsumer({
      scope: new URL(import.meta.env.BASE_URL, location.origin),
      onLaunch: (next) => {
        setIssue(undefined);
        setTarget(next.url);
      },
      onRejected: (next) => {
        setTarget("");
        setIssue(next);
      },
    });
    setSupported(consumer.supported);
    return consumer.dispose;
  }, []);
  return (
    <section class="island">
      <h1>Installed app launch</h1>
      <output data-launch-support>{supported === undefined ? "checking" : supported ? "supported" : "unsupported"}</output>
      {target && <p data-launch-target>{target}</p>}
      {issue && <p role="alert">The requested app destination is not valid.</p>}
    </section>
  );
}
`,
  );
}

async function installFileHandlerRecipe(projectRoot: string) {
  await patchManifest(projectRoot, (manifest) => {
    manifest.file_handlers = [{
      action: "./import/",
      accept: { "application/json": [".json"] },
    }];
  });
  await Deno.writeTextFile(
    join(projectRoot, "src", "pages", "import.astro"),
    `---
import FileImport from "../islands/FileImport.tsx";
import Shell from "../layouts/Shell.astro";
import "../styles/global.css";
---

<Shell title="Import field notes">
  <FileImport client:load />
</Shell>
`,
  );
  await Deno.writeTextFile(
    join(projectRoot, "src", "islands", "FileImport.tsx"),
    `import { useEffect, useState } from "preact/hooks";
import {
  installFileLaunchConsumer,
  prepareFileImportDrafts,
  type FileImportDraft,
  type FileImportIssue,
} from "@nzip/lofi/recipes/file-handler";

type Preview = { title: string };
const options = {
  accept: { "application/json": [".json"] },
  maxFiles: 1,
  maxFileBytes: 128,
  async parse(file: File): Promise<Preview> {
    const value: unknown = JSON.parse(await file.text());
    if (!value || typeof value !== "object" || typeof (value as { title?: unknown }).title !== "string") {
      throw new Error("invalid field notes export");
    }
    return { title: (value as { title: string }).title };
  },
} as const;

export default function FileImport() {
  const [supported, setSupported] = useState<boolean>();
  const [drafts, setDrafts] = useState<readonly FileImportDraft<Preview>[]>([]);
  const [issue, setIssue] = useState<FileImportIssue>();
  const [confirmed, setConfirmed] = useState(false);

  const receive = (next: readonly FileImportDraft<Preview>[]) => {
    setConfirmed(false);
    setIssue(undefined);
    setDrafts(next);
  };
  useEffect(() => {
    const consumer = installFileLaunchConsumer({
      ...options,
      onDrafts: receive,
      onRejected: (next) => {
        setDrafts([]);
        setIssue(next);
      },
    });
    setSupported(consumer.supported);
    return consumer.dispose;
  }, []);

  async function pick(files: FileList | null) {
    const result = await prepareFileImportDrafts(files ? [...files] : [], options);
    if (result.ok) receive(result.drafts);
    else {
      setDrafts([]);
      setIssue(result.issue);
    }
  }

  return (
    <section class="island">
      <h1>Import field notes</h1>
      <output data-file-support>{supported === undefined ? "checking" : supported ? "supported" : "unsupported"}</output>
      <label>Choose an export <input type="file" accept="application/json,.json" onChange={(event) => void pick(event.currentTarget.files)} /></label>
      {drafts.map((draft) => <p data-file-title>{draft.parsed.title}</p>)}
      {drafts.length > 0 && <button type="button" onClick={() => setConfirmed(true)}>Import these notes</button>}
      {confirmed && <p role="status">Import confirmed.</p>}
      {issue && <p role="alert">This file cannot be imported.</p>}
    </section>
  );
}
`,
  );
}

async function installProtocolHandlerRecipe(projectRoot: string) {
  await patchManifest(projectRoot, (manifest) => {
    manifest.protocol_handlers = [{ protocol: "web+lofi", url: "./open-item/?url=%s" }];
  });
  await Deno.writeTextFile(
    join(projectRoot, "src", "pages", "open-item.astro"),
    `---
import ProtocolItem from "../islands/ProtocolItem.tsx";
import Shell from "../layouts/Shell.astro";
import "../styles/global.css";
---

<Shell title="Open collaborative-list item">
  <ProtocolItem client:load />
</Shell>
`,
  );
  await Deno.writeTextFile(
    join(projectRoot, "src", "islands", "ProtocolItem.tsx"),
    `import { useEffect, useState } from "preact/hooks";
import {
  parseCollaborativeListProtocolTarget,
  type CollaborativeListProtocolResult,
} from "@nzip/lofi/recipes/protocol-handler";

export default function ProtocolItem() {
  const [result, setResult] = useState<CollaborativeListProtocolResult>();
  useEffect(() => {
    setResult(parseCollaborativeListProtocolTarget(location.search, {
      protocol: "web+lofi",
      parameter: "url",
      maxLength: 256,
    }));
  }, []);
  const base = import.meta.env.BASE_URL;
  if (!result) return <p role="status">Opening item…</p>;
  if (!result.ok) return (
    <section class="island">
      <h1>Open collaborative-list item</h1>
      <p role="alert">This item link is not valid.</p>
      <a data-protocol-fallback href={base}>Open the app normally</a>
    </section>
  );
  const { listId, itemId } = result.target;
  const fallback = new URL(base, location.origin);
  fallback.searchParams.set("list", listId);
  fallback.searchParams.set("item", itemId);
  return (
    <section class="island">
      <h1>Open collaborative-list item</h1>
      <p data-protocol-list>{listId}</p>
      <p data-protocol-item>{itemId}</p>
      <a data-protocol-fallback href={fallback.href}>Open with HTTPS</a>
    </section>
  );
}
`,
  );
}

async function installRelatedAppDiscoveryRecipe(projectRoot: string) {
  await patchManifest(projectRoot, (manifest) => {
    manifest.prefer_related_applications = false;
    manifest.related_applications = [{
      platform: "play",
      id: "com.example.companion",
      url: "https://play.google.com/store/apps/details?id=com.example.companion",
    }];
  });
  await Deno.writeTextFile(
    join(projectRoot, "src", "pages", "companion.astro"),
    `---
import CompanionDiscovery from "../islands/CompanionDiscovery.tsx";
import Shell from "../layouts/Shell.astro";
import "../styles/global.css";
---
<Shell title="Companion app"><CompanionDiscovery client:load /></Shell>
`,
  );
  await Deno.writeTextFile(
    join(projectRoot, "src", "islands", "CompanionDiscovery.tsx"),
    `import { useEffect, useState } from "preact/hooks";
import { discoverRelatedApplications, type RelatedApplicationDiscovery } from "@nzip/lofi/recipes/related-app-discovery";
const allow = [{ platform: "play", id: "com.example.companion", url: "https://play.google.com/store/apps/details?id=com.example.companion" }] as const;
export default function CompanionDiscovery() {
  const [result, setResult] = useState<RelatedApplicationDiscovery>();
  useEffect(() => { void discoverRelatedApplications({ allow }).then(setResult); }, []);
  const installed = result?.status === "installed";
  return <section class="island"><h1>Companion app</h1><output data-related-status>{result?.status ?? "checking"}</output>{!installed && <p data-related-onboarding>Get the companion app</p>}{installed && <p data-related-installed>Companion already installed</p>}<p data-related-auth>Sign-in and permissions are unchanged.</p></section>;
}
`,
  );
}

async function installScopeExtensionRecipe(projectRoot: string) {
  await patchManifest(projectRoot, (manifest) => {
    manifest.scope_extensions = [{ type: "origin", origin: "https://help.example.com" }];
  });
  await Deno.writeTextFile(
    join(projectRoot, "src", "pages", "scope-extension.astro"),
    `---
import {
  createScopeExtension,
  createWebAppOriginAssociation,
  verifyWebAppOriginAssociation,
} from "@nzip/lofi/recipes/scope-extension";
import Shell from "../layouts/Shell.astro";
import "../styles/global.css";
const declaration = createScopeExtension("https://help.example.com");
const expected = { manifestId: "https://app.example.com/notes", scope: "/notes/" };
const association = createWebAppOriginAssociation(expected);
const verified = verifyWebAppOriginAssociation(association, expected);
---
<Shell title="Product help">
  <section class="island">
    <h1>Product help origin</h1>
    <output data-scope-origin>{declaration.origin}</output>
    <output data-scope-association>{verified ? JSON.stringify(association) : "invalid"}</output>
    <a data-scope-fallback href="https://help.example.com/notes/">Open product help</a>
  </section>
</Shell>
`,
  );
}

async function installWindowControlsOverlayRecipe(projectRoot: string) {
  await patchManifest(projectRoot, (manifest) => {
    manifest.display_override = ["window-controls-overlay"];
  });
  await Deno.writeTextFile(
    join(projectRoot, "src", "pages", "desktop-titlebar.astro"),
    `---
import DesktopTitlebar from "../islands/DesktopTitlebar.tsx";
import Shell from "../layouts/Shell.astro";
import "../styles/global.css";
---
<Shell title="Desktop workspace">
  <DesktopTitlebar client:load />
</Shell>
<style is:global>
  .desktop-titlebar { min-block-size: 3rem; display: flex; align-items: center; gap: .75rem; border-block-end: 1px solid CanvasText; }
  @media (display-mode: window-controls-overlay) {
    .desktop-titlebar { position: fixed; left: env(titlebar-area-x, 0px); top: env(titlebar-area-y, 0px); width: env(titlebar-area-width, 100%); height: env(titlebar-area-height, 3rem); min-block-size: 0; app-region: drag; }
    .desktop-titlebar :is(button, output) { app-region: no-drag; }
  }
  @media (forced-colors: active) { .desktop-titlebar { border-color: CanvasText; } }
</style>
`,
  );
  await Deno.writeTextFile(
    join(projectRoot, "src", "islands", "DesktopTitlebar.tsx"),
    `import { useEffect, useState } from "preact/hooks";
import { observeWindowControlsOverlay, type WindowControlsOverlayGeometry } from "@nzip/lofi/recipes/window-controls-overlay";
export default function DesktopTitlebar() {
  const [supported, setSupported] = useState<boolean>();
  const [geometry, setGeometry] = useState<WindowControlsOverlayGeometry>();
  useEffect(() => {
    const observer = observeWindowControlsOverlay({ onGeometry: setGeometry });
    setSupported(observer.supported);
    return observer.dispose;
  }, []);
  return <header class="desktop-titlebar" data-desktop-titlebar>
    <strong>Field Notes</strong>
    <button type="button">Workspace menu</button>
    <output data-overlay-support>{supported === undefined ? "checking" : supported ? "supported" : "unsupported"}</output>
    {geometry && <output data-overlay-width>{geometry.titlebarArea.width}</output>}
  </header>;
}
`,
  );
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
      // Backup is a two-step ceremony: the phrase is revealed first and sync
      // is enabled only after the explicit saved-it confirmation (which
      // reloads the document into the managed namespace).
      await page!.getByRole("button", { name: "Back up & enable sync" }).click();
      await page!.locator('[aria-label="Recovery phrase"] li').first().waitFor({
        state: "visible",
        timeout: 30_000,
      });
      await page!.getByRole("button", { name: "I saved my phrase — enable sync" }).click();
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

    await stage("install web-share recipe", () => installWebShareRecipe(projectRoot!));
    await stage("install launch-handler recipe", () => installLaunchHandlerRecipe(projectRoot!));
    await stage("install file-handler recipe", () => installFileHandlerRecipe(projectRoot!));
    await stage(
      "install protocol-handler recipe",
      () => installProtocolHandlerRecipe(projectRoot!),
    );
    await stage(
      "install related-app-discovery recipe",
      () => installRelatedAppDiscoveryRecipe(projectRoot!),
    );
    await stage(
      "install scope-extension recipe",
      () => installScopeExtensionRecipe(projectRoot!),
    );
    await stage(
      "install window-controls-overlay recipe",
      () => installWindowControlsOverlayRecipe(projectRoot!),
    );

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
    await stage("manual install fallback browser", async () => {
      const fallbackPage = await context!.newPage();
      try {
        await fallbackPage.addInitScript(() => {
          const addEventListener = globalThis.addEventListener.bind(globalThis);
          globalThis.addEventListener = ((
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
          ) => {
            if (type !== "beforeinstallprompt") addEventListener(type, listener, options);
          }) as typeof globalThis.addEventListener;
        });
        await fallbackPage.goto(origin, { waitUntil: "domcontentloaded" });
        await fallbackPage.getByText("No in-page install button is available right now.")
          .waitFor({ state: "visible", timeout: 30_000 });
        const guidance = await fallbackPage.locator(".pwa-browser-guidance").textContent() ?? "";
        assert(
          guidance.includes("if offered"),
          "manual browser guidance claimed an unavailable install capability",
        );
      } finally {
        await fallbackPage.close();
      }
    });
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
    await stage("web-share recipe browser", async () => {
      await context!.setOffline(true);
      try {
        await page!.goto(
          `${origin}share/?title=One+task&text=Review+it&url=https%3A%2F%2Fexample.com%2Fnotes`,
          { waitUntil: "domcontentloaded" },
        );
        await page!.getByRole("heading", { name: "Review shared content" }).waitFor({
          state: "visible",
        });
        assert(
          await page!.locator("[data-share-title]").textContent() === "One task",
          "offline share title was not parsed",
        );
        assert(
          await page!.locator("[data-share-url]").getAttribute("href") ===
            "https://example.com/notes",
          "offline share URL was not normalized",
        );
        assert(
          await page!.getByText("Draft confirmed.").count() === 0,
          "received share was confirmed before the user action",
        );
        await page!.getByRole("button", { name: "Add to app" }).click();
        await page!.getByText("Draft confirmed.").waitFor({ state: "visible" });
        await page!.getByRole("button", { name: "Share this draft" }).click();
        await page!.locator("[data-share-outcome]").waitFor({ state: "visible" });
        assert(
          await page!.locator("[data-share-outcome]").textContent() === "fallback",
          "unsupported outbound share did not use the normal web fallback",
        );

        await page!.goto(`${origin}share/?url=javascript%3Aalert%281%29`, {
          waitUntil: "domcontentloaded",
        });
        await page!.getByRole("alert").waitFor({ state: "visible" });
        const invalidText = await page!.locator("body").innerText();
        assert(!invalidText.includes("javascript:"), "invalid share value was echoed in the UI");
      } finally {
        await context!.setOffline(false);
      }

      await page!.addInitScript(() => {
        Object.defineProperty(navigator, "canShare", {
          configurable: true,
          value: () => true,
        });
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: () => Promise.reject(new DOMException("closed", "AbortError")),
        });
      });
      await page!.goto(`${origin}share/?text=Cancelled+share`, {
        waitUntil: "domcontentloaded",
      });
      await page!.getByRole("button", { name: "Share this draft" }).click();
      await page!.locator("[data-share-outcome]").waitFor({ state: "visible" });
      assert(
        await page!.locator("[data-share-outcome]").textContent() === "cancelled",
        "browser cancellation was reported as a failure",
      );
      await page!.goto(origin, { waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "task app after share recipe exercise",
      });
    });
    await stage("launch-handler recipe browser", async () => {
      const unsupportedPage = await context!.newPage();
      try {
        await unsupportedPage.addInitScript(() => {
          Object.defineProperty(globalThis, "launchQueue", {
            configurable: true,
            value: undefined,
          });
        });
        await unsupportedPage.goto(`${origin}launch/`, { waitUntil: "domcontentloaded" });
        await unsupportedPage.locator("[data-launch-support]").waitFor({ state: "visible" });
        assert(
          await unsupportedPage.locator("[data-launch-support]").textContent() === "unsupported",
          "missing launchQueue was not reported as unsupported",
        );
      } finally {
        await unsupportedPage.close();
      }

      await page!.addInitScript(() => {
        let consumer: (parameters: { targetURL?: string }) => void = () => {};
        Object.defineProperty(globalThis, "launchQueue", {
          configurable: true,
          value: {
            setConsumer(next: typeof consumer) {
              consumer = next;
            },
          },
        });
        Object.defineProperty(globalThis, "__LOFI_DELIVER_LAUNCH__", {
          configurable: true,
          value: (targetURL: string) => consumer({ targetURL }),
        });
      });
      await context!.setOffline(true);
      try {
        await page!.goto(`${origin}launch/`, { waitUntil: "domcontentloaded" });
        await waitForReady(
          page!,
          () => document.querySelector("[data-launch-support]")?.textContent === "supported",
          undefined,
          { description: "mock launchQueue consumed" },
        );
        await page!.evaluate((targetURL) => {
          const deliver = (globalThis as typeof globalThis & {
            __LOFI_DELIVER_LAUNCH__?: (targetURL: string) => void;
          }).__LOFI_DELIVER_LAUNCH__;
          deliver?.(targetURL);
        }, `${origin}launch/?item=1#selected`);
        await page!.locator("[data-launch-target]").waitFor({ state: "visible" });
        assert(
          await page!.locator("[data-launch-target]").textContent() ===
            `${origin}launch/?item=1#selected`,
          "valid offline launch target was not normalized",
        );
        await page!.evaluate(() => {
          const deliver = (globalThis as typeof globalThis & {
            __LOFI_DELIVER_LAUNCH__?: (targetURL: string) => void;
          }).__LOFI_DELIVER_LAUNCH__;
          deliver?.("https://outside.invalid/private");
        });
        await page!.getByRole("alert").waitFor({ state: "visible" });
        const rejected = await page!.locator("body").innerText();
        assert(!rejected.includes("outside.invalid"), "rejected launch target leaked into the UI");
      } finally {
        await context!.setOffline(false);
      }
      await page!.goto(origin, { waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "task app after launch-handler exercise",
      });
    });
    await stage("file-handler recipe browser", async () => {
      const unsupportedPage = await context!.newPage();
      try {
        await unsupportedPage.addInitScript(() => {
          Object.defineProperty(globalThis, "launchQueue", {
            configurable: true,
            value: undefined,
          });
        });
        await unsupportedPage.goto(`${origin}import/`, { waitUntil: "domcontentloaded" });
        await unsupportedPage.locator("[data-file-support]").waitFor({ state: "visible" });
        assert(
          await unsupportedPage.locator("[data-file-support]").textContent() === "unsupported",
          "missing launchQueue was not reported as unsupported for file import",
        );
        await unsupportedPage.locator('input[type="file"]').setInputFiles({
          name: "picker.json",
          mimeType: "application/json",
          buffer: Buffer.from('{"title":"Picker import"}'),
        });
        await unsupportedPage.getByText("Picker import").waitFor({ state: "visible" });
      } finally {
        await unsupportedPage.close();
      }

      await page!.addInitScript(() => {
        let consumer: (parameters: { files?: unknown[] }) => void = () => {};
        Object.defineProperty(globalThis, "launchQueue", {
          configurable: true,
          value: {
            setConsumer(next: typeof consumer) {
              consumer = next;
            },
          },
        });
        Object.defineProperty(globalThis, "__LOFI_DELIVER_FILE__", {
          configurable: true,
          value: (name: string, type: string, content: string) =>
            consumer({
              files: [{
                kind: "file",
                name,
                getFile: () => Promise.resolve(new File([content], name, { type })),
              }],
            }),
        });
      });
      await context!.setOffline(true);
      try {
        await page!.goto(`${origin}import/`, { waitUntil: "domcontentloaded" });
        await waitForReady(
          page!,
          () => document.querySelector("[data-file-support]")?.textContent === "supported",
          undefined,
          { description: "mock launchQueue consumed by file import" },
        );
        await page!.evaluate(() => {
          const deliver = (globalThis as typeof globalThis & {
            __LOFI_DELIVER_FILE__?: (name: string, type: string, content: string) => void;
          }).__LOFI_DELIVER_FILE__;
          deliver?.("opened.json", "application/json", '{"title":"Opened import"}');
        });
        await page!.getByText("Opened import").waitFor({ state: "visible" });
        assert(
          await page!.getByText("Import confirmed.").count() === 0,
          "received file was persisted before explicit confirmation",
        );
        await page!.getByRole("button", { name: "Import these notes" }).click();
        await page!.getByText("Import confirmed.").waitFor({ state: "visible" });
        await page!.evaluate(() => {
          const deliver = (globalThis as typeof globalThis & {
            __LOFI_DELIVER_FILE__?: (name: string, type: string, content: string) => void;
          }).__LOFI_DELIVER_FILE__;
          deliver?.("private.txt", "text/plain", "private-value");
        });
        await page!.getByRole("alert").waitFor({ state: "visible" });
        const rejected = await page!.locator("body").innerText();
        assert(!rejected.includes("private-value"), "rejected file content leaked into the UI");
        assert(!rejected.includes("private.txt"), "rejected file name leaked into the UI");
      } finally {
        await context!.setOffline(false);
      }
      await page!.goto(origin, { waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "task app after file-handler exercise",
      });
    });
    await stage("protocol-handler recipe browser", async () => {
      await context!.setOffline(true);
      try {
        const payload = encodeURIComponent(
          "web+lofi:collaborative-list/list_123/item/item_456",
        );
        await page!.goto(`${origin}open-item/?url=${payload}`, {
          waitUntil: "domcontentloaded",
        });
        await page!.getByText("list_123").waitFor({ state: "visible" });
        await page!.getByText("item_456").waitFor({ state: "visible" });
        const fallback = await page!.locator("[data-protocol-fallback]").getAttribute("href");
        assert(
          fallback === `${origin}?list=list_123&item=item_456`,
          "protocol recipe did not preserve the ordinary HTTPS fallback",
        );

        const invalid = encodeURIComponent("web+lofi:https://outside.invalid/private-value");
        await page!.goto(`${origin}open-item/?url=${invalid}`, {
          waitUntil: "domcontentloaded",
        });
        await page!.getByRole("alert").waitFor({ state: "visible" });
        const rejected = await page!.locator("body").innerText();
        assert(!rejected.includes("outside.invalid"), "rejected protocol host leaked into the UI");
        assert(!rejected.includes("private-value"), "rejected protocol value leaked into the UI");

        await page!.goto(`${origin}open-item/`, { waitUntil: "domcontentloaded" });
        await page!.getByRole("alert").waitFor({ state: "visible" });
        assert(
          await page!.locator("[data-protocol-fallback]").getAttribute("href") === "/",
          "direct handler visit lost its ordinary app fallback",
        );
      } finally {
        await context!.setOffline(false);
      }
      await page!.goto(origin, { waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "task app after protocol-handler exercise",
      });
    });
    await stage("related-app-discovery recipe browser", async () => {
      const unsupportedPage = await context!.newPage();
      try {
        await unsupportedPage.addInitScript(() => {
          Object.defineProperty(navigator, "getInstalledRelatedApps", {
            configurable: true,
            value: undefined,
          });
        });
        await unsupportedPage.goto(`${origin}companion/`, { waitUntil: "domcontentloaded" });
        await unsupportedPage.locator("[data-related-onboarding]").waitFor({ state: "visible" });
        await waitForReady(
          unsupportedPage,
          () => document.querySelector("[data-related-status]")?.textContent === "unsupported",
          undefined,
          { description: "unsupported related-app discovery" },
        );
      } finally {
        await unsupportedPage.close();
      }
      await page!.addInitScript(() => {
        Object.defineProperty(navigator, "getInstalledRelatedApps", {
          configurable: true,
          value: () =>
            Promise.resolve([{
              platform: "play",
              id: "com.example.companion",
              url: "https://play.google.com/store/apps/details?id=com.example.companion",
              version: "private-version",
            }]),
        });
      });
      await page!.goto(`${origin}companion/`, { waitUntil: "domcontentloaded" });
      await page!.locator("[data-related-installed]").waitFor({ state: "visible" });
      assert(
        await page!.locator("[data-related-auth]").textContent() ===
          "Sign-in and permissions are unchanged.",
        "discovery presentation implied an auth or authorization change",
      );
      assert(
        !(await page!.locator("body").innerText()).includes("private-version"),
        "browser-supplied companion version leaked into presentation",
      );
      await page!.goto(origin, { waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "task app after related-app discovery exercise",
      });
    });
    await stage("scope-extension recipe browser", async () => {
      await page!.goto(`${origin}scope-extension/`, { waitUntil: "domcontentloaded" });
      assert(
        await page!.locator("[data-scope-origin]").textContent() === "https://help.example.com",
        "scope extension origin was not normalized",
      );
      const association = await page!.locator("[data-scope-association]").textContent() ?? "";
      assert(
        association.includes('"https://app.example.com/notes":{"scope":"/notes/"}'),
        "reciprocal association was not generated and verified",
      );
      assert(
        await page!.locator("[data-scope-fallback]").getAttribute("href") ===
          "https://help.example.com/notes/",
        "unsupported scope extension lost ordinary external navigation",
      );
      await page!.goto(origin, { waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "task app after scope-extension exercise",
      });
    });
    await stage("window-controls-overlay recipe browser", async () => {
      await page!.goto(`${origin}desktop-titlebar/`, { waitUntil: "domcontentloaded" });
      const titlebar = page!.locator("[data-desktop-titlebar]");
      await titlebar.waitFor({ state: "visible" });
      await page!.getByRole("button", { name: "Workspace menu" }).focus();
      assert(
        await page!.getByRole("button", { name: "Workspace menu" }).evaluate((element) =>
          element === document.activeElement
        ),
        "titlebar controls were not keyboard reachable",
      );
      const box = await titlebar.boundingBox();
      assert(
        Boolean(box && box.width > 0 && box.height > 0),
        "standalone titlebar fallback collapsed",
      );
      await context!.setOffline(true);
      try {
        await page!.goto(`${origin}desktop-titlebar/`, { waitUntil: "domcontentloaded" });
        await page!.locator("[data-desktop-titlebar]").waitFor({ state: "visible" });
      } finally {
        await context!.setOffline(false);
      }
      await page!.goto(origin, { waitUntil: "domcontentloaded" });
      await waitForReady(page!, taskAppReady, undefined, {
        description: "task app after window-controls-overlay exercise",
      });
    });
    await stage("waiting worker update browser", async () => {
      const workerPath = join(projectRoot!, "dist", "sw.js");
      const worker = await Deno.readTextFile(workerPath);
      await Deno.writeTextFile(workerPath, `${worker}\n// golden update ${Date.now()}\n`);
      await page!.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitForReady(
        page!,
        () => {
          const global = globalThis as typeof globalThis & {
            __LOFI_PWA_STATE__?: { update?: string };
          };
          return global.__LOFI_PWA_STATE__?.update === "ready";
        },
        undefined,
        { description: "waiting service-worker update", timeoutMs: 30_000 },
      );
      await Promise.all([
        page!.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
        page!.getByRole("button", { name: "Update app" }).click(),
      ]);
      await waitForReady(
        page!,
        () => {
          const global = globalThis as typeof globalThis & {
            __LOFI_PWA_STATE__?: { worker?: string; update?: string };
          };
          return global.__LOFI_PWA_STATE__?.worker === "ready" &&
            global.__LOFI_PWA_STATE__?.update === "idle";
        },
        undefined,
        { description: "applied service-worker update", timeoutMs: 30_000 },
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
