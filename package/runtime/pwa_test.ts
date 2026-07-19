import {
  classifyInstallExperience,
  createPwaController,
  type InstallPromptEvent,
  type PwaController,
  type PwaInstallState,
  type PwaState,
  resolvePwaResources,
  waitForActivation,
} from "./pwa.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

class FakeServiceWorker extends EventTarget {
  state: ServiceWorkerState;
  readonly messages: unknown[] = [];

  constructor(state: ServiceWorkerState) {
    super();
    this.state = state;
  }

  transition(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }

  postMessage(message: unknown) {
    this.messages.push(message);
  }
}

class FakeRegistration extends EventTarget {
  installing: ServiceWorker | null = null;
  waiting: ServiceWorker | null = null;
  active: ServiceWorker | null = null;
  updateCalls = 0;
  updateImplementation: () => Promise<ServiceWorkerRegistration> = () =>
    Promise.resolve(this as unknown as ServiceWorkerRegistration);

  update(): Promise<ServiceWorkerRegistration> {
    this.updateCalls += 1;
    return this.updateImplementation();
  }
}

class FakeContainer extends EventTarget {
  controller: ServiceWorker | null = null;
  registration = new FakeRegistration();
  registerError: Error | undefined;
  registeredUrl: string | undefined;
  registeredScope: string | undefined;

  register(url: string | URL, options?: RegistrationOptions): Promise<ServiceWorkerRegistration> {
    this.registeredUrl = String(url);
    this.registeredScope = options?.scope;
    if (this.registerError) return Promise.reject(this.registerError);
    return Promise.resolve(this.registration as unknown as ServiceWorkerRegistration);
  }
}

function asServiceWorker(worker: FakeServiceWorker): ServiceWorker {
  return worker as unknown as ServiceWorker;
}

function testController(options: {
  production?: boolean;
  container?: FakeContainer;
  target?: EventTarget;
  install?: PwaInstallState;
  reload?: () => void;
  deploymentBaseUrl?: string;
  visibilityTarget?: EventTarget;
  isVisible?: () => boolean;
  now?: () => number;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  updateCheckIntervalMs?: number;
  updateCheckTimeoutMs?: number;
  prepareUpdateSwap?: () => Promise<void>;
  staleTabBehavior?: () => "reload" | "prompt";
  onStaleTab?: () => void;
} = {}): PwaController {
  const environment = options.install === "manual-ios"
    ? { platform: "iPhone", maxTouchPoints: 5 }
    : { platform: "Linux x86_64", maxTouchPoints: 0 };
  return createPwaController({
    eventTarget: () => options.target ?? new EventTarget(),
    visibilityTarget: () => options.visibilityTarget ?? new EventTarget(),
    serviceWorker: () => options.container as unknown as ServiceWorkerContainer,
    installEnvironment: () => ({
      displayModeStandalone: options.install === "installed",
      navigatorStandalone: false,
      secureContext: options.install !== "unsupported",
      serviceWorkerSupported: options.install !== "unsupported",
      ...environment,
    }),
    isVisible: options.isVisible,
    now: options.now,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    updateCheckIntervalMs: options.updateCheckIntervalMs,
    updateCheckTimeoutMs: options.updateCheckTimeoutMs,
    production: () => options.production ?? false,
    deploymentBaseUrl: () => options.deploymentBaseUrl ?? "http://127.0.0.1:4321/",
    reload: options.reload,
    prepareUpdateSwap: options.prepareUpdateSwap,
    staleTabBehavior: options.staleTabBehavior,
    onStaleTab: options.onStaleTab,
  });
}

test("PWA resources resolve from the deployment base instead of the current route", () => {
  const resources = resolvePwaResources("https://example.com/field-notes");
  if (resources.workerUrl.href !== "https://example.com/field-notes/sw.js") {
    throw new Error(`unexpected worker URL ${resources.workerUrl.href}`);
  }
  if (resources.scope !== "/field-notes/") throw new Error(`unexpected scope ${resources.scope}`);
});

test("nested direct visits register the worker at the configured non-root base", async () => {
  const container = new FakeContainer();
  container.registration.active = asServiceWorker(new FakeServiceWorker("activated"));
  const controller = testController({
    container,
    production: true,
    deploymentBaseUrl: "https://example.com/field-notes/",
  });
  controller.initialize();
  await waitForState(controller, (state) => state.worker === "ready");
  if (container.registeredUrl !== "https://example.com/field-notes/sw.js") {
    throw new Error(`registered the wrong worker URL: ${container.registeredUrl}`);
  }
  if (container.registeredScope !== "/field-notes/") {
    throw new Error(`registered the wrong scope: ${container.registeredScope}`);
  }
});

function waitForState(controller: PwaController, predicate: (state: PwaState) => boolean) {
  return new Promise<PwaState>((resolve) => {
    const unsubscribe = controller.subscribe((state) => {
      if (!predicate(state)) return;
      unsubscribe();
      resolve(state);
    });
  });
}

function installPrompt(
  outcome: "accepted" | "dismissed",
  prompted: () => void,
): InstallPromptEvent {
  return Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt() {
      prompted();
      return Promise.resolve();
    },
    userChoice: Promise.resolve({ outcome }),
  }) as InstallPromptEvent;
}

test("service worker activation resolves for an active worker", async () => {
  await waitForActivation(asServiceWorker(new FakeServiceWorker("activated")));
});

test("service worker activation waits for the activated state", async () => {
  const worker = new FakeServiceWorker("installing");
  const activation = waitForActivation(asServiceWorker(worker));
  worker.transition("activated");
  await activation;
});

test("service worker activation rejects a redundant install", async () => {
  const worker = new FakeServiceWorker("installing");
  const activation = waitForActivation(asServiceWorker(worker));
  worker.transition("redundant");
  await activation.then(
    () => {
      throw new Error("expected redundant worker to reject");
    },
    (error) => {
      if (!(error instanceof Error) || !error.message.includes("installation failed")) throw error;
    },
  );
});

test("install experience recognizes standalone display modes", () => {
  const state = classifyInstallExperience({
    displayModeStandalone: true,
    navigatorStandalone: false,
    platform: "Linux armv8l",
    maxTouchPoints: 5,
    secureContext: true,
    serviceWorkerSupported: true,
  });
  if (state !== "installed") throw new Error(`expected installed, received ${state}`);
});

test("install experience gives iOS manual guidance in every region", () => {
  const iphone = classifyInstallExperience({
    displayModeStandalone: false,
    navigatorStandalone: false,
    platform: "iPhone",
    maxTouchPoints: 5,
    secureContext: true,
    serviceWorkerSupported: true,
  });
  const ipadDesktopMode = classifyInstallExperience({
    displayModeStandalone: false,
    navigatorStandalone: false,
    platform: "MacIntel",
    maxTouchPoints: 5,
    secureContext: true,
    serviceWorkerSupported: true,
  });
  if (iphone !== "manual-ios" || ipadDesktopMode !== "manual-ios") {
    throw new Error(`expected iOS guidance, received ${iphone} and ${ipadDesktopMode}`);
  }
});

test("install experience distinguishes manual browser fallback from unsupported contexts", () => {
  const manual = classifyInstallExperience({
    displayModeStandalone: false,
    navigatorStandalone: false,
    platform: "Linux x86_64",
    maxTouchPoints: 0,
    secureContext: true,
    serviceWorkerSupported: true,
  });
  const unsupported = classifyInstallExperience({
    displayModeStandalone: false,
    navigatorStandalone: false,
    platform: "Linux x86_64",
    maxTouchPoints: 0,
    secureContext: false,
    serviceWorkerSupported: true,
  });
  if (manual !== "manual-browser" || unsupported !== "unsupported") {
    throw new Error(`unexpected fallback states ${manual} and ${unsupported}`);
  }
});

test("install prompt availability and accepted outcome are observable", async () => {
  const target = new EventTarget();
  const controller = testController({ target });
  controller.initialize();
  let prompted = false;
  target.dispatchEvent(installPrompt("accepted", () => prompted = true));
  if (controller.getState().install !== "available") throw new Error("prompt was not exposed");
  if (await controller.requestInstall() !== "accepted" || !prompted) {
    throw new Error("accepted prompt outcome was not reflected");
  }
});

test("dismissed install outcome and appinstalled are observable", async () => {
  const target = new EventTarget();
  const controller = testController({ target });
  controller.initialize();
  target.dispatchEvent(installPrompt("dismissed", () => undefined));
  if (await controller.requestInstall() !== "dismissed") {
    throw new Error("dismissed prompt outcome was not reflected");
  }
  target.dispatchEvent(new Event("appinstalled"));
  if (controller.getState().install !== "installed") throw new Error("appinstalled was ignored");
});

test("waiting-worker update activation posts skip-waiting and reloads on controller change", async () => {
  const target = new EventTarget();
  const container = new FakeContainer();
  const waiting = new FakeServiceWorker("installed");
  container.controller = asServiceWorker(new FakeServiceWorker("activated"));
  container.registration.waiting = asServiceWorker(waiting);
  let reloaded = false;
  const controller = testController({
    target,
    container,
    production: true,
    reload: () => reloaded = true,
  });
  const available = waitForState(controller, (state) => state.update === "ready");
  controller.initialize();
  await available;
  if (await controller.checkForUpdate() || container.registration.updateCalls !== 0) {
    throw new Error("foreground check replaced an actionable waiting update");
  }
  if (!controller.applyUpdate()) throw new Error("update action was unavailable");
  if (controller.getState().update !== "applying") {
    throw new Error("update application state was not observable");
  }
  if (JSON.stringify(waiting.messages) !== JSON.stringify([{ type: "LOFI_SKIP_WAITING" }])) {
    throw new Error("update action did not request activation");
  }
  container.dispatchEvent(new Event("controllerchange"));
  if (!reloaded) throw new Error("controller change did not reload after update action");
  reloaded = false;
  container.dispatchEvent(new Event("controllerchange"));
  if (reloaded) throw new Error("one update action caused a reload loop");
});

test("a coordinated update quiesces sibling writes before requesting activation", async () => {
  const container = new FakeContainer();
  const waiting = new FakeServiceWorker("installed");
  container.controller = asServiceWorker(new FakeServiceWorker("activated"));
  container.registration.waiting = asServiceWorker(waiting);
  let releaseQuiescence: () => void = () => undefined;
  const quiescence = new Promise<void>((resolve) => releaseQuiescence = resolve);
  const controller = testController({
    container,
    production: true,
    reload: () => undefined,
    prepareUpdateSwap: () => quiescence,
  });
  const available = waitForState(controller, (state) => state.update === "ready");
  controller.initialize();
  await available;
  if (!controller.applyUpdate()) throw new Error("update action was unavailable");
  if (controller.getState().update !== "applying") {
    throw new Error("coordinated update application state was not observable");
  }
  await Promise.resolve();
  if (waiting.messages.length !== 0) {
    throw new Error("activation was requested before sibling writes quiesced");
  }
  releaseQuiescence();
  await quiescence;
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  if (JSON.stringify(waiting.messages) !== JSON.stringify([{ type: "LOFI_SKIP_WAITING" }])) {
    throw new Error("quiescence did not hand off to the worker swap");
  }
});

test("a rejected quiescence still proceeds to the worker swap", async () => {
  const container = new FakeContainer();
  const waiting = new FakeServiceWorker("installed");
  container.controller = asServiceWorker(new FakeServiceWorker("activated"));
  container.registration.waiting = asServiceWorker(waiting);
  const controller = testController({
    container,
    production: true,
    reload: () => undefined,
    prepareUpdateSwap: () => Promise.reject(new Error("locks unavailable")),
  });
  const available = waitForState(controller, (state) => state.update === "ready");
  controller.initialize();
  await available;
  if (!controller.applyUpdate()) throw new Error("update action was unavailable");
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  if (JSON.stringify(waiting.messages) !== JSON.stringify([{ type: "LOFI_SKIP_WAITING" }])) {
    throw new Error("a failed quiescence blocked the swap");
  }
});

test("the prompt preference keeps a bystander tab and reports it stale", async () => {
  const container = new FakeContainer();
  container.controller = asServiceWorker(new FakeServiceWorker("activated"));
  container.registration.active = asServiceWorker(new FakeServiceWorker("activated"));
  let reloaded = 0;
  let staleReports = 0;
  const controller = testController({
    container,
    production: true,
    reload: () => reloaded += 1,
    staleTabBehavior: () => "prompt",
    onStaleTab: () => staleReports += 1,
  });
  controller.initialize();
  await waitForState(controller, (state) => state.worker === "ready");
  container.dispatchEvent(new Event("controllerchange"));
  if (reloaded !== 0) throw new Error("the prompt preference still reloaded the bystander tab");
  if (staleReports !== 1) throw new Error("the stale tab was not reported");
  if (controller.getState().update !== "idle") {
    throw new Error("the stale tab kept a stale update state");
  }
});

test("a controlled tab reloads on an update another tab initiated", async () => {
  // The new worker prunes the old revision's caches, so every claimed tab
  // must leave the old HTML/module graph — not only the tab that clicked.
  const container = new FakeContainer();
  container.controller = asServiceWorker(new FakeServiceWorker("activated"));
  container.registration.active = asServiceWorker(new FakeServiceWorker("activated"));
  let reloaded = 0;
  const controller = testController({
    container,
    production: true,
    reload: () => reloaded += 1,
  });
  controller.initialize();
  await waitForState(controller, (state) => state.worker === "ready");
  container.dispatchEvent(new Event("controllerchange"));
  if (reloaded !== 1) throw new Error("a bystander tab kept the stale document after an update");
  container.dispatchEvent(new Event("controllerchange"));
  if (reloaded !== 1) throw new Error("a document must reload at most once per lifetime");
});

test("the first claim of an uncontrolled page never reloads", async () => {
  const container = new FakeContainer();
  container.registration.active = asServiceWorker(new FakeServiceWorker("activated"));
  let reloaded = false;
  const controller = testController({
    container,
    production: true,
    reload: () => reloaded = true,
  });
  controller.initialize();
  await waitForState(controller, (state) => state.worker === "ready");
  container.dispatchEvent(new Event("controllerchange"));
  if (reloaded) throw new Error("clients.claim() on first visit must not reload the page");
});

test("foreground update checks are single-flight and rate-limited", async () => {
  const target = new EventTarget();
  const visibility = new EventTarget();
  const container = new FakeContainer();
  const active = new FakeServiceWorker("activated");
  container.controller = asServiceWorker(active);
  container.registration.active = asServiceWorker(active);
  let currentTime = 0;
  let resolveUpdate: ((registration: ServiceWorkerRegistration) => void) | undefined;
  container.registration.updateImplementation = () =>
    new Promise((resolve) => resolveUpdate = resolve);
  const controller = testController({
    target,
    visibilityTarget: visibility,
    isVisible: () => true,
    container,
    production: true,
    now: () => currentTime,
    updateCheckIntervalMs: 100,
  });
  controller.initialize();
  await waitForState(controller, (state) => state.worker === "ready");
  visibility.dispatchEvent(new Event("visibilitychange"));
  target.dispatchEvent(new Event("online"));
  await Promise.resolve();
  if (container.registration.updateCalls !== 1 || controller.getState().update !== "checking") {
    throw new Error("overlapping foreground signals did not share one update check");
  }
  const idle = waitForState(controller, (state) => state.update === "idle");
  resolveUpdate?.(container.registration as unknown as ServiceWorkerRegistration);
  await idle;
  target.dispatchEvent(new Event("online"));
  await Promise.resolve();
  if (container.registration.updateCalls !== 1) {
    throw new Error("update check ignored the rate limit");
  }
  currentTime = 100;
  container.registration.updateImplementation = () =>
    Promise.resolve(container.registration as unknown as ServiceWorkerRegistration);
  target.dispatchEvent(new Event("online"));
  await Promise.resolve();
  await Promise.resolve();
  if (Number(container.registration.updateCalls) !== 2) {
    throw new Error("update check did not resume after the rate limit");
  }
});

test("a bounded foreground update failure leaves the active worker ready", async () => {
  const target = new EventTarget();
  const container = new FakeContainer();
  const active = new FakeServiceWorker("activated");
  container.controller = asServiceWorker(active);
  container.registration.active = asServiceWorker(active);
  container.registration.updateImplementation = () => new Promise(() => undefined);
  let expire: (() => void) | undefined;
  const controller = testController({
    target,
    container,
    production: true,
    setTimeout: (callback) => {
      expire = callback;
      return 1;
    },
    clearTimeout: () => undefined,
  });
  controller.initialize();
  await waitForState(controller, (state) => state.worker === "ready");
  const failed = waitForState(controller, (state) => state.update === "failed");
  target.dispatchEvent(new Event("online"));
  await Promise.resolve();
  expire?.();
  const state = await failed;
  if (state.worker !== "ready" || state.failure?.code !== "update-check") {
    throw new Error("bounded update failure was reported as an active-worker failure");
  }
});

test("an installing update becomes explicitly ready", async () => {
  const container = new FakeContainer();
  const active = new FakeServiceWorker("activated");
  container.controller = asServiceWorker(active);
  container.registration.active = asServiceWorker(active);
  const controller = testController({ container, production: true });
  controller.initialize();
  await waitForState(controller, (state) => state.worker === "ready");
  const installing = new FakeServiceWorker("installing");
  container.registration.installing = asServiceWorker(installing);
  container.registration.dispatchEvent(new Event("updatefound"));
  if (controller.getState().update !== "installing") {
    throw new Error("installing update state was hidden");
  }
  const ready = waitForState(controller, (state) => state.update === "ready");
  installing.transition("installed");
  await ready;
});

test("registration failure is classified without leaking the browser error", async () => {
  const container = new FakeContainer();
  container.registerError = new Error("private registration detail");
  const controller = testController({ container, production: true });
  const failed = waitForState(controller, (state) => state.failure?.code === "registration");
  controller.initialize();
  const state = await failed;
  if (state.failure?.message.includes("private")) throw new Error("registration detail leaked");
  if (!state.failure?.message.includes("Reload")) {
    throw new Error("registration failure is not actionable");
  }
});

test("installation failure is classified from a redundant update", async () => {
  const container = new FakeContainer();
  const active = new FakeServiceWorker("activated");
  container.registration.active = asServiceWorker(active);
  container.controller = asServiceWorker(active);
  const controller = testController({ container, production: true });
  controller.initialize();
  await waitForState(controller, (state) => state.worker === "ready");
  const installing = new FakeServiceWorker("installing");
  container.registration.installing = asServiceWorker(installing);
  container.registration.dispatchEvent(new Event("updatefound"));
  const failed = waitForState(controller, (state) => state.failure?.code === "installation");
  installing.transition("redundant");
  await failed;
});

for (const code of ["precache", "runtime-cache"] as const) {
  test(`${code} worker failure is classified without exposing message payloads`, async () => {
    const container = new FakeContainer();
    container.registration.active = asServiceWorker(new FakeServiceWorker("activated"));
    const controller = testController({ container, production: true });
    controller.initialize();
    await waitForState(controller, (state) => state.worker === "ready");
    const failed = waitForState(controller, (state) => state.failure?.code === code);
    container.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "LOFI_PWA_FAILURE", code, message: "private cache detail" },
      }),
    );
    const state = await failed;
    if (state.failure?.message.includes("private")) throw new Error(`${code} detail leaked`);
    if (!state.failure?.message.includes("Reconnect")) {
      throw new Error(`${code} failure is not actionable`);
    }
    const expectedWorker = code === "runtime-cache" ? "ready" : "failed";
    if (state.worker !== expectedWorker) {
      throw new Error(`${code} produced worker state ${state.worker}, expected ${expectedWorker}`);
    }
  });
}
