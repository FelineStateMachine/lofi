/// <reference path="./env.d.ts" />
// Package-owned PWA lifecycle.
/** Service-worker lifecycle states exposed to application UI. */
export type PwaWorkerState =
  | "development-disabled"
  | "unsupported"
  | "registering"
  | "ready"
  | "update-available"
  | "failed";

/** Browser installation states exposed to application UI. */
export type PwaInstallState =
  | "installed"
  | "available"
  | "prompting"
  | "accepted"
  | "dismissed"
  | "manual-ios"
  | "unavailable";

/** Stable categories for recoverable offline/PWA failures. */
export type PwaFailureCode = "registration" | "installation" | "precache" | "runtime-cache";

/** Current install, service-worker, and offline-cache state. */
export type PwaState = {
  worker: PwaWorkerState;
  install: PwaInstallState;
  failure?: {
    code: PwaFailureCode;
    message: string;
  };
};

/** Chromium install event retained until application UI requests the prompt. */
export type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/** Browser signals used to classify installed and manual-install experiences. */
export type InstallEnvironment = {
  displayModeStandalone: boolean;
  navigatorStandalone: boolean;
  platform: string;
  maxTouchPoints: number;
};

type LofiPwaGlobal = typeof globalThis & { __LOFI_PWA_STATE__?: PwaState };

const actionableFailureMessages: Record<PwaFailureCode, string> = {
  registration:
    "Offline support could not start. Reload on a stable connection; if it continues, clear this site's storage and retry.",
  installation:
    "The offline update could not install. Reconnect, keep this tab open, and reload to try again.",
  precache:
    "Required offline files were not saved. Reconnect, reload, and wait for offline support before disconnecting.",
  "runtime-cache":
    "A recently opened file was not saved for offline use. Reconnect and open it again before going offline.",
};

/** Returns actionable, non-technical recovery guidance for a PWA failure. */
export function pwaFailureMessage(code: PwaFailureCode): string {
  return actionableFailureMessages[code];
}

/** Injectable browser surfaces used to test the PWA lifecycle deterministically. */
export type PwaControllerDependencies = {
  readonly eventTarget?: () => EventTarget;
  readonly serviceWorker?: () => ServiceWorkerContainer | undefined;
  readonly installEnvironment?: () => InstallEnvironment;
  readonly production?: () => boolean;
  /** Absolute URL of the configured deployment base, independent of the current route. */
  readonly deploymentBaseUrl?: () => string;
  /** @deprecated Supply deploymentBaseUrl when injecting browser location in tests. */
  readonly documentBaseURI?: () => string;
  readonly reload?: () => void;
  readonly exposeState?: (state: PwaState) => void;
};

/** Stateful controller for browser installation and service-worker updates. */
export type PwaController = {
  getState(): PwaState;
  subscribe(subscriber: (state: PwaState) => void): () => void;
  requestInstall(): Promise<PwaInstallState>;
  applyUpdate(): boolean;
  initialize(): void;
};

/** Resolves the worker URL and scope from one configured application base. */
export function resolvePwaResources(deploymentBaseUrl: string): {
  workerUrl: URL;
  scope: string;
} {
  const base = new URL(deploymentBaseUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  base.search = "";
  base.hash = "";
  return { workerUrl: new URL("sw.js", base), scope: base.pathname };
}

export function classifyInstallExperience(environment: InstallEnvironment): PwaInstallState {
  if (environment.displayModeStandalone || environment.navigatorStandalone) return "installed";
  const iosLike = /^(iPhone|iPad|iPod)$/.test(environment.platform) ||
    (environment.platform === "MacIntel" && environment.maxTouchPoints > 1);
  return iosLike ? "manual-ios" : "unavailable";
}

export function waitForActivation(worker: ServiceWorker): Promise<void> {
  if (worker.state === "activated") return Promise.resolve();
  if (worker.state === "redundant") return Promise.reject(new Error("service worker is redundant"));

  return new Promise((resolve, reject) => {
    const onStateChange = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onStateChange);
        resolve();
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("service worker installation failed"));
      }
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
}

/** Creates an isolated PWA controller, primarily for custom integration and tests. */
export function createPwaController(dependencies: PwaControllerDependencies = {}): PwaController {
  const subscribers = new Set<(state: PwaState) => void>();
  let deferredInstallPrompt: InstallPromptEvent | undefined;
  let waitingWorker: ServiceWorker | undefined;
  let reloadForUpdate = false;
  let initialized = false;
  let state: PwaState = { worker: "registering", install: "unavailable" };

  const publish = (next: PwaState) => {
    state = next;
    dependencies.exposeState?.(state);
    for (const subscriber of subscribers) subscriber(state);
  };
  const update = (patch: Partial<PwaState>) => publish({ ...state, ...patch });
  const fail = (code: PwaFailureCode) => {
    update({ worker: "failed", failure: { code, message: pwaFailureMessage(code) } });
  };
  const target = () => dependencies.eventTarget?.() ?? globalThis;
  const serviceWorker = () =>
    dependencies.serviceWorker?.() ??
      (typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? navigator.serviceWorker
        : undefined);
  const installEnvironment = () =>
    dependencies.installEnvironment?.() ?? {
      displayModeStandalone: matchMedia("(display-mode: standalone)").matches,
      navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    };

  const watchForUpdate = (
    registration: ServiceWorkerRegistration,
    container: ServiceWorkerContainer,
  ) => {
    const exposeWaitingWorker = (worker: ServiceWorker) => {
      waitingWorker = worker;
      update({ worker: "update-available", failure: undefined });
    };

    if (registration.waiting && container.controller) exposeWaitingWorker(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && container.controller) {
          exposeWaitingWorker(registration.waiting ?? worker);
        } else if (worker.state === "redundant") {
          fail("installation");
        }
      });
    });
  };

  const watchInstallExperience = () => {
    update({ install: classifyInstallExperience(installEnvironment()) });
    target().addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event as InstallPromptEvent;
      update({ install: "available" });
    });
    target().addEventListener("appinstalled", () => {
      deferredInstallPrompt = undefined;
      update({ install: "installed" });
    });
  };

  const initialize = () => {
    if (initialized) return;
    initialized = true;
    watchInstallExperience();
    if (!(dependencies.production?.() ?? import.meta.env.PROD)) {
      update({ worker: "development-disabled" });
      return;
    }
    const container = serviceWorker();
    if (!container) {
      update({ worker: "unsupported" });
      return;
    }
    update({ worker: "registering" });
    container.addEventListener("message", (event) => {
      const message = (event as MessageEvent).data as { type?: string; code?: PwaFailureCode };
      if (
        message?.type === "LOFI_PWA_FAILURE" &&
        (message.code === "precache" || message.code === "runtime-cache")
      ) fail(message.code);
    });
    container.addEventListener("controllerchange", () => {
      if (!reloadForUpdate) return;
      if (dependencies.reload) dependencies.reload();
      else location.reload();
    });
    const deploymentBaseUrl = dependencies.deploymentBaseUrl?.() ?? (() => {
      const locationOrigin = dependencies.documentBaseURI
        ? new URL(dependencies.documentBaseURI()).origin
        : document.location.origin;
      return new URL(import.meta.env.BASE_URL, locationOrigin).href;
    })();
    const { workerUrl, scope } = resolvePwaResources(deploymentBaseUrl);
    void (async () => {
      const registration = await container.register(workerUrl, {
        scope,
      });
      watchForUpdate(registration, container);
      if (registration.waiting && container.controller) return;
      const worker = registration.installing ?? registration.active ?? registration.waiting;
      if (!worker) throw new Error("service worker registration has no worker");
      try {
        await waitForActivation(worker);
      } catch {
        fail("installation");
        return;
      }
      update({ worker: "ready", failure: undefined });
    })().catch(() => fail("registration"));
  };

  return {
    getState: () => state,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      subscriber(state);
      return () => subscribers.delete(subscriber);
    },
    async requestInstall() {
      const prompt = deferredInstallPrompt;
      if (!prompt) return state.install;
      deferredInstallPrompt = undefined;
      update({ install: "prompting" });
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        const outcome = choice.outcome === "accepted" ? "accepted" : "dismissed";
        update({ install: outcome });
        return outcome;
      } catch {
        update({ install: "unavailable" });
        fail("installation");
        return "unavailable";
      }
    },
    applyUpdate() {
      if (!waitingWorker) return false;
      reloadForUpdate = true;
      waitingWorker.postMessage({ type: "LOFI_SKIP_WAITING" });
      return true;
    },
    initialize,
  };
}

/** Shared controller used by the root runtime and optional Preact bindings. */
export const pwaController: PwaController = createPwaController({
  exposeState(next) {
    if (typeof document !== "undefined") (globalThis as LofiPwaGlobal).__LOFI_PWA_STATE__ = next;
  },
});

/** Returns the shared controller's current state snapshot. */
export function getPwaState(): PwaState {
  return pwaController.getState();
}

/** Subscribes to shared PWA state and returns an idempotent unsubscribe function. */
export function subscribePwaState(subscriber: (state: PwaState) => void): () => void {
  return pwaController.subscribe(subscriber);
}

/** Requests the deferred browser installation prompt when one is available. */
export function requestPwaInstall(): Promise<PwaInstallState> {
  return pwaController.requestInstall();
}

/** Activates a waiting service worker; returns false when no update is ready. */
export function applyPwaUpdate(): boolean {
  return pwaController.applyUpdate();
}

export function registerProductionServiceWorker(): void {
  pwaController.initialize();
}
