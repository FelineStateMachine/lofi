import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  type ConsoleMessage,
  type Locator,
  type Page,
  type Request,
} from "npm:playwright@1.61.1";
import { BrowserUnavailableError, rethrowBrowserLaunchError } from "./browser_error.ts";
import {
  artifactName,
  assertValueFreeState,
  redactDiagnosticText,
  type ValueFreeState,
} from "./safety.ts";
import { sanitizeTraceArchive } from "./trace.ts";

type MemoryStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
/**
 * Playwright context options with `storageState` forbidden, so identity never
 * leaves memory via an on-disk state file.
 */
export type SafeContextOptions = Omit<BrowserContextOptions, "storageState"> & {
  /** Identity state is managed in memory by the fixture. File paths are forbidden. */
  storageState?: never;
};

/** Identifies which of the fixture's two clients a value belongs to. */
export type ClientName = "first" | "second";

/** A redacted console, page-error, or failed-request record captured from a client. */
export interface BrowserDiagnostic {
  /** Which of the two clients produced this diagnostic. */
  readonly client: ClientName;
  /** What surfaced it: a console message, an uncaught page error, or a failed request. */
  readonly kind: "console" | "page-error" | "request-failed";
  /** Console severity (e.g. `"error"`, `"warning"`), when applicable. */
  readonly level?: string;
  /** The redacted message text. */
  readonly message: string;
  /** The associated URL, for `request-failed` records. */
  readonly url?: string;
}

/**
 * How the two clients obtain identity: `shared` clones the primary's prepared
 * state (in memory) into the second client, `isolated` prepares each client on
 * its own.
 */
export type IdentityOptions =
  | {
    readonly mode: "shared";
    /** Runs before tracing starts. The resulting state is cloned only in memory. */
    readonly preparePrimary: (client: BrowserTestClient) => Promise<void>;
  }
  | {
    readonly mode: "isolated";
    /** Runs independently for each client before tracing starts. */
    readonly prepare?: (client: BrowserTestClient) => Promise<void>;
  };

/** Configures where and how redacted failure artifacts are written on capture. */
export interface FailureArtifactOptions {
  /** Directory the redacted artifacts are written into on capture. */
  readonly directory: string;
  /** Literal credential values to remove from retained diagnostics. */
  readonly secretValues?: readonly string[];
  /** Locators containing private UI values that screenshots should mask. */
  readonly mask?: (client: BrowserTestClient) => readonly Locator[];
}

/** Options for constructing a {@link TwoClientFixture} via {@link createTwoClientFixture}. */
export interface TwoClientFixtureOptions {
  /** The origin both clients open and enroll identity against. */
  readonly baseURL: string;
  /** How the two clients obtain identity (`shared` or `isolated`). */
  readonly identity: IdentityOptions;
  /** An existing browser to reuse; when omitted the fixture launches and owns one. */
  readonly browser?: Browser;
  /** Extra context options (a disk `storageState` is forbidden to keep identity in memory). */
  readonly context?: SafeContextOptions;
  /** Where and how to write redacted artifacts if the test fails. */
  readonly artifacts?: FailureArtifactOptions;
  /** Defaults to true. Tracing begins only after identity preparation. */
  readonly traceOnFailure?: boolean;
}

/** Re-exported so callers can catch a missing-Chromium launch failure. */
export { BrowserUnavailableError };

function validateContextOptions(options: SafeContextOptions | undefined): void {
  if (options && "storageState" in options) {
    throw new TypeError(
      "context.storageState is not accepted; use an identity mode so state stays in memory",
    );
  }
}

/**
 * One browser client (context + page) whose identity and IndexedDB stay in
 * memory. Records redacted diagnostics and can go offline/online, restart, and
 * capture a sanitized trace.
 */
export class BrowserTestClient {
  readonly #diagnostics: BrowserDiagnostic[] = [];
  #context: BrowserContext;
  #page: Page;
  #offline = false;
  #recording = false;
  #closed = false;

  /** Constructed by {@link createTwoClientFixture}; not intended for direct use. */
  constructor(
    readonly name: ClientName,
    context: BrowserContext,
    page: Page,
    readonly baseURL: string,
    private readonly createContext: (state?: MemoryStorageState) => Promise<BrowserContext>,
    private readonly redact: (value: string) => string,
    private readonly traceOnFailure: boolean,
  ) {
    this.#context = context;
    this.#page = page;
  }

  /** The client's current Playwright browser context. */
  get context(): BrowserContext {
    return this.#context;
  }

  /** The client's current Playwright page. */
  get page(): Page {
    return this.#page;
  }

  /** Whether the client's network is currently forced offline. */
  get offline(): boolean {
    return this.#offline;
  }

  /** Redacted diagnostics collected from the client's pages so far. */
  get diagnostics(): readonly BrowserDiagnostic[] {
    return this.#diagnostics;
  }

  /** Attach diagnostic listeners and, if enabled, begin failure tracing. */
  async startRecording(): Promise<void> {
    if (this.#recording || this.#closed) return;
    this.#attachDiagnostics(this.#page);
    if (this.traceOnFailure) {
      await this.#context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    }
    this.#recording = true;
  }

  /** Force the client's network offline. */
  async goOffline(): Promise<void> {
    await this.#context.setOffline(true);
    this.#offline = true;
  }

  /** Restore the client's network to online. */
  async goOnline(): Promise<void> {
    await this.#context.setOffline(false);
    this.#offline = false;
  }

  /** Reload the current page without replacing its browser-side client state. */
  async reloadPage(): Promise<Page> {
    await this.#page.reload({ waitUntil: "domcontentloaded" });
    return this.#page;
  }

  /** Close and recreate the page inside the same identity/context. */
  async restartPage(): Promise<Page> {
    const previous = this.#page;
    await previous.close();
    this.#page = await this.#context.newPage();
    this.#attachDiagnostics(this.#page);
    await this.#page.goto(this.baseURL, { waitUntil: "domcontentloaded" });
    return this.#page;
  }

  /**
   * Restart the whole context, preserving identity and IndexedDB only in memory.
   * A new context starts online because service-worker/cache state is not part of
   * Playwright storageState; use restartPage for an offline PWA restart.
   */
  async restartClient(options: { preserveIdentity?: boolean } = {}): Promise<Page> {
    const preserveIdentity = options.preserveIdentity ?? true;
    let state: MemoryStorageState | undefined;
    if (preserveIdentity) {
      state = await this.#context.storageState({ indexedDB: true });
    }
    await this.#discardTrace();
    await this.#context.close();
    this.#context = await this.createContext(state ? structuredClone(state) : undefined);
    state = undefined;
    this.#page = await this.#context.newPage();
    this.#offline = false;
    this.#recording = false;
    await this.startRecording();
    await this.#page.goto(this.baseURL, { waitUntil: "domcontentloaded" });
    return this.#page;
  }

  /**
   * Stop tracing and write a sanitized trace archive to `path`. Returns false
   * when tracing was not active; removes the archive if sanitization fails.
   */
  async captureTrace(path: string): Promise<boolean> {
    if (!this.#recording || !this.traceOnFailure) return false;
    await this.#context.tracing.stop({ path });
    this.#recording = false;
    try {
      await sanitizeTraceArchive(path, this.redact);
    } catch (error) {
      await Deno.remove(path).catch(() => undefined);
      throw error;
    }
    return true;
  }

  /** Discard any pending trace and close the client's context. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#discardTrace();
    await this.#context.close();
  }

  #attachDiagnostics(page: Page): void {
    page.on("console", (message: ConsoleMessage) => {
      this.#diagnostics.push({
        client: this.name,
        kind: "console",
        level: message.type(),
        message: this.redact(message.text()),
        url: this.redact(message.location().url),
      });
    });
    page.on("pageerror", (error: Error) => {
      this.#diagnostics.push({
        client: this.name,
        kind: "page-error",
        message: this.redact(`${error.name}: ${error.message}`),
      });
    });
    page.on("requestfailed", (request: Request) => {
      this.#diagnostics.push({
        client: this.name,
        kind: "request-failed",
        message: this.redact(request.failure()?.errorText ?? "request failed"),
        url: this.redact(request.url()),
      });
    });
  }

  async #discardTrace(): Promise<void> {
    if (!this.#recording || !this.traceOnFailure) return;
    await this.#context.tracing.stop().catch(() => undefined);
    this.#recording = false;
  }
}

/** The directory and file paths produced by a failure capture. */
export interface FailureArtifacts {
  /** The directory the artifacts were written into. */
  readonly directory: string;
  /** Absolute paths of every file written (screenshots, traces, diagnostics). */
  readonly files: readonly string[];
}

/**
 * Coordinates a pair of {@link BrowserTestClient}s sharing one browser, with
 * helpers to take both clients offline/online and to capture redacted,
 * value-free failure artifacts.
 */
export class TwoClientFixture {
  /** The fixture's two clients, ordered `[first, second]`. */
  readonly clients: readonly [BrowserTestClient, BrowserTestClient];
  #closed = false;

  /** Constructed by {@link createTwoClientFixture}; not intended for direct use. */
  constructor(
    readonly browser: Browser,
    readonly ownsBrowser: boolean,
    first: BrowserTestClient,
    second: BrowserTestClient,
    private readonly artifacts: FailureArtifactOptions | undefined,
  ) {
    this.clients = [first, second];
  }

  /** The first client. */
  get first(): BrowserTestClient {
    return this.clients[0];
  }

  /** The second client. */
  get second(): BrowserTestClient {
    return this.clients[1];
  }

  /** Take both clients offline. */
  async goOffline(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.goOffline()));
  }

  /** Restore both clients to online. */
  async goOnline(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.goOnline()));
  }

  /**
   * Write redacted screenshots, traces, diagnostics, and (optionally) a
   * value-free state-shape snapshot under a label-named directory. Returns
   * undefined when no artifact directory was configured.
   */
  async captureFailure(
    label: string,
    snapshot?: (client: BrowserTestClient) => Promise<ValueFreeState>,
  ): Promise<FailureArtifacts | undefined> {
    if (!this.artifacts) return undefined;
    const directory = `${this.artifacts.directory}/${artifactName(label)}`;
    await Deno.mkdir(directory, { recursive: true });
    const files: string[] = [];

    for (const client of this.clients) {
      const screenshot = `${directory}/${client.name}.png`;
      await client.page.screenshot({
        path: screenshot,
        fullPage: true,
        mask: this.artifacts.mask ? [...this.artifacts.mask(client)] : undefined,
      });
      files.push(screenshot);

      const trace = `${directory}/${client.name}.trace.zip`;
      if (await client.captureTrace(trace)) files.push(trace);
    }

    const diagnostics = `${directory}/diagnostics.json`;
    await Deno.writeTextFile(
      diagnostics,
      `${JSON.stringify(this.clients.flatMap((client) => client.diagnostics), null, 2)}\n`,
    );
    files.push(diagnostics);

    if (snapshot) {
      const states: Record<ClientName, ValueFreeState> = {
        first: await snapshot(this.first),
        second: await snapshot(this.second),
      };
      assertValueFreeState(states);
      const statePath = `${directory}/state-shape.json`;
      await Deno.writeTextFile(statePath, `${JSON.stringify(states, null, 2)}\n`);
      files.push(statePath);
    }
    return { directory, files };
  }

  /**
   * Close both clients and, when the fixture owns it, the browser. Idempotent;
   * rethrows the first client close failure.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const results = await Promise.allSettled(this.clients.map((client) => client.close()));
    if (this.ownsBrowser) await this.browser.close();
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }
}

/**
 * Launch (or reuse) a browser and build a {@link TwoClientFixture}: opens both
 * clients at `baseURL`, applies the chosen identity mode with state kept in
 * memory, and starts recording. Cleans up on any setup failure.
 */
export async function createTwoClientFixture(
  options: TwoClientFixtureOptions,
): Promise<TwoClientFixture> {
  validateContextOptions(options.context);
  let browser = options.browser;
  const ownsBrowser = !browser;
  if (!browser) {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      rethrowBrowserLaunchError(error);
    }
  }

  const contextOptions = { ...options.context, baseURL: options.baseURL };
  const createContext = (state?: MemoryStorageState) =>
    browser.newContext({
      ...contextOptions,
      storageState: state ? structuredClone(state) : undefined,
    });
  const redact = (value: string) =>
    redactDiagnosticText(value, options.artifacts?.secretValues ?? []);
  const traceOnFailure = options.traceOnFailure ?? true;
  let first: BrowserTestClient | undefined;
  let second: BrowserTestClient | undefined;

  try {
    const firstContext = await createContext();
    const firstPage = await firstContext.newPage();
    first = new BrowserTestClient(
      "first",
      firstContext,
      firstPage,
      options.baseURL,
      createContext,
      redact,
      traceOnFailure,
    );
    await firstPage.goto(options.baseURL, { waitUntil: "domcontentloaded" });

    let sharedState: MemoryStorageState | undefined;
    if (options.identity.mode === "shared") {
      await options.identity.preparePrimary(first);
      sharedState = await firstContext.storageState({ indexedDB: true });
    } else if (options.identity.prepare) {
      await options.identity.prepare(first);
    }

    const secondContext = await createContext(
      sharedState ? structuredClone(sharedState) : undefined,
    );
    sharedState = undefined;
    const secondPage = await secondContext.newPage();
    second = new BrowserTestClient(
      "second",
      secondContext,
      secondPage,
      options.baseURL,
      createContext,
      redact,
      traceOnFailure,
    );
    await secondPage.goto(options.baseURL, { waitUntil: "domcontentloaded" });
    if (options.identity.mode === "isolated" && options.identity.prepare) {
      await options.identity.prepare(second);
    }

    await Promise.all([first.startRecording(), second.startRecording()]);
    return new TwoClientFixture(browser, ownsBrowser, first, second, options.artifacts);
  } catch (error) {
    await Promise.allSettled([first?.close(), second?.close()].filter(Boolean));
    if (ownsBrowser) await browser.close().catch(() => undefined);
    throw error;
  }
}
