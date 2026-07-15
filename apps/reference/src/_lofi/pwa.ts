export type PwaRegistrationState =
  | "development-disabled"
  | "unsupported"
  | "registering"
  | "ready"
  | "failed";

declare global {
  interface Window {
    __LOFI_PWA_STATE__?: PwaRegistrationState;
  }
}

function setState(state: PwaRegistrationState) {
  if (typeof document !== "undefined") {
    (globalThis as typeof globalThis & Window).__LOFI_PWA_STATE__ = state;
  }
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

export function registerProductionServiceWorker(): void {
  if (!import.meta.env.PROD) {
    setState("development-disabled");
    return;
  }
  if (!("serviceWorker" in navigator)) {
    setState("unsupported");
    return;
  }
  setState("registering");
  const workerUrl = new URL("./sw.js", document.baseURI);
  void (async () => {
    const registration = await navigator.serviceWorker.register(workerUrl);
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (!worker) throw new Error("service worker registration has no worker");
    await waitForActivation(worker);
    setState("ready");
  })().catch(() => setState("failed"));
}
