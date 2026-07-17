/// <reference path="./env.d.ts" />
// Package-owned PWA lifecycle.
export type PwaWorkerState =
  | "development-disabled"
  | "unsupported"
  | "registering"
  | "ready"
  | "update-available"
  | "failed";

export type PwaInstallState =
  | "installed"
  | "available"
  | "prompting"
  | "accepted"
  | "dismissed"
  | "manual-ios"
  | "unavailable";

export type PwaFailureCode = "registration" | "installation" | "precache" | "runtime-cache";

export type PwaState = {
  worker: PwaWorkerState;
  install: PwaInstallState;
  failure?: {
    code: PwaFailureCode;
    message: string;
  };
};

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type NavigatorWithStandalone = Navigator & { standalone?: boolean };

type InstallEnvironment = {
  displayModeStandalone: boolean;
  navigatorStandalone: boolean;
  platform: string;
  maxTouchPoints: number;
};

type LofiPwaGlobal = typeof globalThis & { __LOFI_PWA_STATE__?: PwaState };

const subscribers = new Set<(state: PwaState) => void>();
let deferredInstallPrompt: InstallPromptEvent | undefined;
let waitingWorker: ServiceWorker | undefined;
let reloadForUpdate = false;
let initialized = false;

let state: PwaState = {
  worker: "registering",
  install: "unavailable",
};

function publish(next: PwaState) {
  state = next;
  if (typeof document !== "undefined") {
    (globalThis as LofiPwaGlobal).__LOFI_PWA_STATE__ = state;
  }
  for (const subscriber of subscribers) subscriber(state);
}

function update(patch: Partial<PwaState>) {
  publish({ ...state, ...patch });
}

export function getPwaState(): PwaState {
  return state;
}

export function subscribePwaState(subscriber: (state: PwaState) => void): () => void {
  subscribers.add(subscriber);
  subscriber(state);
  return () => subscribers.delete(subscriber);
}

export function classifyInstallExperience(environment: InstallEnvironment): PwaInstallState {
  if (environment.displayModeStandalone || environment.navigatorStandalone) return "installed";
  const iosLike = /^(iPhone|iPad|iPod)$/.test(environment.platform) ||
    (environment.platform === "MacIntel" && environment.maxTouchPoints > 1);
  return iosLike ? "manual-ios" : "unavailable";
}

function currentInstallExperience(): PwaInstallState {
  const standalone = navigator as NavigatorWithStandalone;
  return classifyInstallExperience({
    displayModeStandalone: matchMedia("(display-mode: standalone)").matches,
    navigatorStandalone: standalone.standalone === true,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

export async function requestPwaInstall(): Promise<PwaInstallState> {
  const prompt = deferredInstallPrompt;
  if (!prompt) return state.install;
  deferredInstallPrompt = undefined;
  update({ install: "prompting" });
  await prompt.prompt();
  const choice = await prompt.userChoice;
  const outcome = choice.outcome === "accepted" ? "accepted" : "dismissed";
  update({ install: outcome });
  return outcome;
}

export function applyPwaUpdate(): boolean {
  if (!waitingWorker) return false;
  reloadForUpdate = true;
  waitingWorker.postMessage({ type: "LOFI_SKIP_WAITING" });
  return true;
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

function watchForUpdate(registration: ServiceWorkerRegistration) {
  const exposeWaitingWorker = (worker: ServiceWorker) => {
    waitingWorker = worker;
    update({ worker: "update-available" });
  };

  if (registration.waiting && navigator.serviceWorker.controller) {
    exposeWaitingWorker(registration.waiting);
  }
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        exposeWaitingWorker(registration.waiting ?? worker);
      }
      if (worker.state === "redundant") {
        update({
          worker: "failed",
          failure: { code: "installation", message: "service worker installation failed" },
        });
      }
    });
  });
}

function watchInstallExperience() {
  update({ install: currentInstallExperience() });
  globalThis.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event as InstallPromptEvent;
    update({ install: "available" });
  });
  globalThis.addEventListener("appinstalled", () => {
    deferredInstallPrompt = undefined;
    update({ install: "installed" });
  });
}

function watchWorkerMessages() {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = event.data as {
      type?: string;
      code?: PwaFailureCode;
      message?: string;
    };
    if (
      message?.type !== "LOFI_PWA_FAILURE" ||
      !["precache", "runtime-cache"].includes(message.code ?? "")
    ) return;
    update({
      worker: "failed",
      failure: {
        code: message.code as PwaFailureCode,
        message: message.message || "service worker cache operation failed",
      },
    });
  });
}

export function registerProductionServiceWorker(): void {
  if (initialized || typeof document === "undefined") return;
  initialized = true;
  watchInstallExperience();
  if (!import.meta.env.PROD) {
    update({ worker: "development-disabled" });
    return;
  }
  if (!("serviceWorker" in navigator)) {
    update({ worker: "unsupported" });
    return;
  }
  update({ worker: "registering" });
  watchWorkerMessages();
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadForUpdate) location.reload();
  });
  const workerUrl = new URL("./sw.js", document.baseURI);
  void (async () => {
    const registration = await navigator.serviceWorker.register(workerUrl, {
      scope: new URL("./", document.baseURI).pathname,
    });
    watchForUpdate(registration);
    if (registration.waiting && navigator.serviceWorker.controller) return;
    const worker = registration.installing ?? registration.active ?? registration.waiting;
    if (!worker) throw new Error("service worker registration has no worker");
    await waitForActivation(worker);
    update({ worker: "ready", failure: undefined });
  })().catch((error) => {
    update({
      worker: "failed",
      failure: {
        code: "registration",
        message: error instanceof Error ? error.message : "service worker registration failed",
      },
    });
  });
}
