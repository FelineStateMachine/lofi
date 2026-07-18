/// <reference path="./env.d.ts" />
// Package-owned PWA lifecycle.
/** Service-worker lifecycle states exposed to application UI. */
export type PwaWorkerState =
  | "development-disabled"
  | "unsupported"
  | "registering"
  | "ready"
  | "failed";

/** Browser installation states exposed to application UI. */
export type PwaInstallState =
  | "installed"
  | "available"
  | "prompting"
  | "accepted"
  | "dismissed"
  | "manual-ios"
  | "manual-browser"
  | "unsupported";

/** Foreground update-check and waiting-worker states exposed to application UI. */
export type PwaUpdateState =
  | "idle"
  | "checking"
  | "installing"
  | "ready"
  | "applying"
  | "failed";

/** Stable categories for recoverable offline/PWA failures. */
export type PwaFailureCode =
  | "registration"
  | "installation"
  | "install-prompt"
  | "update-check"
  | "precache"
  | "runtime-cache";

/** Current install, service-worker, and offline-cache state. */
export type PwaState = {
  worker: PwaWorkerState;
  install: PwaInstallState;
  update: PwaUpdateState;
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
  secureContext: boolean;
  serviceWorkerSupported: boolean;
};

type LofiPwaGlobal = typeof globalThis & { __LOFI_PWA_STATE__?: PwaState };

const actionableFailureMessages: Record<PwaFailureCode, string> = {
  registration:
    "Offline support could not start. Reload on a stable connection; if it continues, clear this site's storage and retry.",
  installation:
    "The offline update could not install. Reconnect, keep this tab open, and reload to try again.",
  "install-prompt":
    "The browser install prompt could not open. Use the browser menu if it offers Install app or Add to Home Screen.",
  "update-check":
    "The app could not check for an update. Reconnect and bring it to the foreground to try again.",
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
  readonly visibilityTarget?: () => EventTarget;
  readonly serviceWorker?: () => ServiceWorkerContainer | undefined;
  readonly installEnvironment?: () => InstallEnvironment;
  readonly isVisible?: () => boolean;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Minimum time between foreground update checks; defaults to one minute. */
  readonly updateCheckIntervalMs?: number;
  /** Maximum time exposed as an active update check; defaults to ten seconds. */
  readonly updateCheckTimeoutMs?: number;
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
  checkForUpdate(): Promise<boolean>;
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
  if (iosLike && environment.secureContext) return "manual-ios";
  return environment.secureContext && environment.serviceWorkerSupported
    ? "manual-browser"
    : "unsupported";
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
  const observedUpdateWorkers = new WeakSet<ServiceWorker>();
  let deferredInstallPrompt: InstallPromptEvent | undefined;
  let waitingWorker: ServiceWorker | undefined;
  let activeRegistration: ServiceWorkerRegistration | undefined;
  let activeContainer: ServiceWorkerContainer | undefined;
  let updateCheck: Promise<boolean> | null = null;
  let lastUpdateCheckAt = Number.NEGATIVE_INFINITY;
  let reloadForUpdate = false;
  let foregroundChecksAttached = false;
  let initialized = false;
  let state: PwaState = { worker: "registering", install: "unsupported", update: "idle" };

  const publish = (next: PwaState) => {
    state = next;
    dependencies.exposeState?.(state);
    for (const subscriber of subscribers) subscriber(state);
  };
  const update = (patch: Partial<PwaState>) => publish({ ...state, ...patch });
  const failure = (code: PwaFailureCode) => ({ code, message: pwaFailureMessage(code) });
  const clearFailure = (...codes: PwaFailureCode[]) =>
    state.failure && codes.includes(state.failure.code) ? undefined : state.failure;
  const failWorker = (code: "registration" | "installation" | "precache") => {
    update({ worker: "failed", failure: { code, message: pwaFailureMessage(code) } });
  };
  const failUpdate = (code: "installation" | "update-check") => {
    update({ update: "failed", failure: failure(code) });
  };
  const target = () => dependencies.eventTarget?.() ?? globalThis;
  const visibilityTarget = () =>
    dependencies.visibilityTarget?.() ??
      (typeof document !== "undefined" ? document : target());
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
      secureContext: globalThis.isSecureContext,
      serviceWorkerSupported: "serviceWorker" in navigator,
    };
  const isVisible = () =>
    dependencies.isVisible?.() ??
      (typeof document === "undefined" || document.visibilityState === "visible");
  const now = () => dependencies.now?.() ?? Date.now();
  const scheduleTimeout = (callback: () => void, milliseconds: number) =>
    dependencies.setTimeout
      ? dependencies.setTimeout(callback, milliseconds)
      : globalThis.setTimeout(callback, milliseconds);
  const cancelTimeout = (handle: unknown) => {
    if (dependencies.clearTimeout) dependencies.clearTimeout(handle);
    else globalThis.clearTimeout(handle as number);
  };
  const updateCheckIntervalMs = dependencies.updateCheckIntervalMs ?? 60_000;
  const updateCheckTimeoutMs = dependencies.updateCheckTimeoutMs ?? 10_000;

  const boundedRegistrationUpdate = (
    registration: ServiceWorkerRegistration,
  ): Promise<ServiceWorkerRegistration> =>
    new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle: unknown = undefined;
      const finish = () => {
        if (settled) return false;
        settled = true;
        if (timeoutHandle !== undefined) cancelTimeout(timeoutHandle);
        return true;
      };
      timeoutHandle = scheduleTimeout(
        () => {
          if (finish()) reject(new Error("service worker update check timed out"));
        },
        updateCheckTimeoutMs,
      );
      Promise.resolve().then(() => registration.update()).then(
        (next) => {
          if (finish()) resolve(next);
        },
        (error) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });

  const checkForUpdate = (): Promise<boolean> => {
    const registration = activeRegistration;
    const container = activeContainer;
    if (!registration || !container?.controller || state.worker !== "ready") {
      return Promise.resolve(false);
    }
    if (
      state.update === "installing" || state.update === "ready" || state.update === "applying"
    ) {
      return Promise.resolve(false);
    }
    if (updateCheck) return updateCheck;
    const checkedAt = now();
    if (checkedAt - lastUpdateCheckAt < updateCheckIntervalMs) return Promise.resolve(false);
    lastUpdateCheckAt = checkedAt;
    update({
      update: "checking",
      failure: clearFailure("update-check"),
    });
    const operation = boundedRegistrationUpdate(registration).then(
      () => {
        if (state.update === "checking") {
          update({ update: "idle", failure: clearFailure("update-check") });
        }
        return true;
      },
      () => {
        if (state.update === "checking") failUpdate("update-check");
        return true;
      },
    );
    const tracked = operation.finally(() => {
      if (updateCheck === tracked) updateCheck = null;
    });
    updateCheck = tracked;
    return tracked;
  };

  const requestUpdateFromEvent = () => {
    void checkForUpdate();
  };
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted === true) requestUpdateFromEvent();
  };
  const onVisibilityChange = () => {
    if (isVisible()) requestUpdateFromEvent();
  };
  const attachForegroundChecks = () => {
    if (foregroundChecksAttached) return;
    foregroundChecksAttached = true;
    target().addEventListener("pageshow", onPageShow);
    target().addEventListener("online", requestUpdateFromEvent);
    visibilityTarget().addEventListener("visibilitychange", onVisibilityChange);
  };

  const watchForUpdate = (
    registration: ServiceWorkerRegistration,
    container: ServiceWorkerContainer,
  ) => {
    const exposeWaitingWorker = (worker: ServiceWorker) => {
      waitingWorker = worker;
      update({
        worker: "ready",
        update: "ready",
        failure: clearFailure("installation", "update-check"),
      });
    };
    const observeInstallingWorker = (worker: ServiceWorker) => {
      if (observedUpdateWorkers.has(worker)) return;
      observedUpdateWorkers.add(worker);
      update({
        worker: "ready",
        update: "installing",
        failure: clearFailure("installation", "update-check"),
      });
      const onStateChange = () => {
        if (worker.state === "installed") {
          exposeWaitingWorker(registration.waiting ?? worker);
        } else if (worker.state === "activated") {
          update({ worker: "ready", update: "idle" });
        } else if (worker.state === "redundant") {
          failUpdate("installation");
        }
      };
      worker.addEventListener("statechange", onStateChange);
      onStateChange();
    };

    if (registration.waiting && container.controller) exposeWaitingWorker(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (worker && container.controller) observeInstallingWorker(worker);
    });
    if (registration.installing && container.controller) {
      observeInstallingWorker(registration.installing);
    }
  };

  const watchInstallExperience = () => {
    update({ install: classifyInstallExperience(installEnvironment()) });
    target().addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event as InstallPromptEvent;
      update({ install: "available", failure: clearFailure("install-prompt") });
    });
    target().addEventListener("appinstalled", () => {
      deferredInstallPrompt = undefined;
      update({ install: "installed", failure: clearFailure("install-prompt") });
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
      ) {
        if (message.code === "precache") failWorker("precache");
        else update({ failure: failure("runtime-cache") });
      }
    });
    // A controller change means a new worker took over this tab. Every
    // controlled tab must reload — the new worker prunes the old revision's
    // caches, so a document kept on the old HTML/module graph goes stale —
    // not just the tab whose applyUpdate() initiated the change. The first
    // claim of a previously uncontrolled page does not reload, and a document
    // reloads at most once, so a misbehaving worker cannot cause a loop.
    let hadController = Boolean(container.controller);
    let reloadedForController = false;
    container.addEventListener("controllerchange", () => {
      const wasControlled = hadController;
      hadController = true;
      const initiated = reloadForUpdate;
      reloadForUpdate = false;
      if (!initiated && !wasControlled) return;
      if (reloadedForController) return;
      reloadedForController = true;
      waitingWorker = undefined;
      update({
        worker: "ready",
        update: "idle",
        failure: clearFailure("installation", "update-check"),
      });
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
      activeRegistration = registration;
      activeContainer = container;
      watchForUpdate(registration, container);
      attachForegroundChecks();
      if (registration.waiting && container.controller) return;
      if (registration.installing && container.controller) return;
      const worker = registration.installing ?? registration.active ?? registration.waiting;
      if (!worker) throw new Error("service worker registration has no worker");
      try {
        await waitForActivation(worker);
      } catch {
        failWorker("installation");
        return;
      }
      update({ worker: "ready", update: "idle", failure: undefined });
    })().catch(() => failWorker("registration"));
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
        const fallback = classifyInstallExperience(installEnvironment());
        update({ install: fallback, failure: failure("install-prompt") });
        return fallback;
      }
    },
    checkForUpdate,
    applyUpdate() {
      if (!waitingWorker || state.update !== "ready") return false;
      reloadForUpdate = true;
      try {
        waitingWorker.postMessage({ type: "LOFI_SKIP_WAITING" });
        update({ update: "applying", failure: clearFailure("installation", "update-check") });
        return true;
      } catch {
        reloadForUpdate = false;
        failUpdate("installation");
        return false;
      }
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

/**
 * Runs the shared controller's bounded update check when registration is ready.
 * Resolves true when a check ran or was already in flight; inspect `PwaState.update` for outcome.
 */
export function checkPwaUpdate(): Promise<boolean> {
  return pwaController.checkForUpdate();
}

/** Activates a waiting service worker; returns false when no update is ready. */
export function applyPwaUpdate(): boolean {
  return pwaController.applyUpdate();
}

export function registerProductionServiceWorker(): void {
  pwaController.initialize();
}
