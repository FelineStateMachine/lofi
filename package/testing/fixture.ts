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
export type SafeContextOptions = Omit<BrowserContextOptions, "storageState"> & {
  /** Identity state is managed in memory by the fixture. File paths are forbidden. */
  storageState?: never;
};

export type ClientName = "first" | "second";

export interface BrowserDiagnostic {
  readonly client: ClientName;
  readonly kind: "console" | "page-error" | "request-failed";
  readonly level?: string;
  readonly message: string;
  readonly url?: string;
}

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

export interface FailureArtifactOptions {
  readonly directory: string;
  /** Literal credential values to remove from retained diagnostics. */
  readonly secretValues?: readonly string[];
  /** Locators containing private UI values that screenshots should mask. */
  readonly mask?: (client: BrowserTestClient) => readonly Locator[];
}

export interface TwoClientFixtureOptions {
  readonly baseURL: string;
  readonly identity: IdentityOptions;
  readonly browser?: Browser;
  readonly context?: SafeContextOptions;
  readonly artifacts?: FailureArtifactOptions;
  /** Defaults to true. Tracing begins only after identity preparation. */
  readonly traceOnFailure?: boolean;
}

export { BrowserUnavailableError };

function validateContextOptions(options: SafeContextOptions | undefined): void {
  if (options && "storageState" in options) {
    throw new TypeError(
      "context.storageState is not accepted; use an identity mode so state stays in memory",
    );
  }
}

export class BrowserTestClient {
  readonly #diagnostics: BrowserDiagnostic[] = [];
  #context: BrowserContext;
  #page: Page;
  #offline = false;
  #recording = false;
  #closed = false;

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

  get context(): BrowserContext {
    return this.#context;
  }

  get page(): Page {
    return this.#page;
  }

  get offline(): boolean {
    return this.#offline;
  }

  get diagnostics(): readonly BrowserDiagnostic[] {
    return this.#diagnostics;
  }

  async startRecording(): Promise<void> {
    if (this.#recording || this.#closed) return;
    this.#attachDiagnostics(this.#page);
    if (this.traceOnFailure) {
      await this.#context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    }
    this.#recording = true;
  }

  async goOffline(): Promise<void> {
    await this.#context.setOffline(true);
    this.#offline = true;
  }

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

export interface FailureArtifacts {
  readonly directory: string;
  readonly files: readonly string[];
}

export class TwoClientFixture {
  readonly clients: readonly [BrowserTestClient, BrowserTestClient];
  #closed = false;

  constructor(
    readonly browser: Browser,
    readonly ownsBrowser: boolean,
    first: BrowserTestClient,
    second: BrowserTestClient,
    private readonly artifacts: FailureArtifactOptions | undefined,
  ) {
    this.clients = [first, second];
  }

  get first(): BrowserTestClient {
    return this.clients[0];
  }

  get second(): BrowserTestClient {
    return this.clients[1];
  }

  async goOffline(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.goOffline()));
  }

  async goOnline(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.goOnline()));
  }

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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const results = await Promise.allSettled(this.clients.map((client) => client.close()));
    if (this.ownsBrowser) await this.browser.close();
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }
}

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
