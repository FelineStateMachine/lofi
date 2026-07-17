import {
  classifyInstallExperience,
  createPwaController,
  type InstallPromptEvent,
  type PwaController,
  type PwaInstallState,
  type PwaState,
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
}

class FakeContainer extends EventTarget {
  controller: ServiceWorker | null = null;
  registration = new FakeRegistration();
  registerError: Error | undefined;

  register(): Promise<ServiceWorkerRegistration> {
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
} = {}): PwaController {
  const environment = options.install === "manual-ios"
    ? { platform: "iPhone", maxTouchPoints: 5 }
    : { platform: "Linux x86_64", maxTouchPoints: 0 };
  return createPwaController({
    eventTarget: () => options.target ?? new EventTarget(),
    serviceWorker: () => options.container as unknown as ServiceWorkerContainer,
    installEnvironment: () => ({
      displayModeStandalone: options.install === "installed",
      navigatorStandalone: false,
      ...environment,
    }),
    production: () => options.production ?? false,
    documentBaseURI: () => "http://127.0.0.1:4321/",
    reload: options.reload,
  });
}

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
  });
  if (state !== "installed") throw new Error(`expected installed, received ${state}`);
});

test("install experience gives iOS manual guidance in every region", () => {
  const iphone = classifyInstallExperience({
    displayModeStandalone: false,
    navigatorStandalone: false,
    platform: "iPhone",
    maxTouchPoints: 5,
  });
  const ipadDesktopMode = classifyInstallExperience({
    displayModeStandalone: false,
    navigatorStandalone: false,
    platform: "MacIntel",
    maxTouchPoints: 5,
  });
  if (iphone !== "manual-ios" || ipadDesktopMode !== "manual-ios") {
    throw new Error(`expected iOS guidance, received ${iphone} and ${ipadDesktopMode}`);
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
  const available = waitForState(controller, (state) => state.worker === "update-available");
  controller.initialize();
  await available;
  if (!controller.applyUpdate()) throw new Error("update action was unavailable");
  if (JSON.stringify(waiting.messages) !== JSON.stringify([{ type: "LOFI_SKIP_WAITING" }])) {
    throw new Error("update action did not request activation");
  }
  container.dispatchEvent(new Event("controllerchange"));
  if (!reloaded) throw new Error("controller change did not reload after update action");
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
  });
}
