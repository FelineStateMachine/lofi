import { classifyInstallExperience, waitForActivation } from "./pwa.ts";
// Package contract tests.

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

class FakeServiceWorker extends EventTarget {
  state: ServiceWorkerState;

  constructor(state: ServiceWorkerState) {
    super();
    this.state = state;
  }

  transition(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

function asServiceWorker(worker: FakeServiceWorker): ServiceWorker {
  return worker as unknown as ServiceWorker;
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

test("install experience gives iOS manual guidance without exposing a prompt event", () => {
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

test("install experience degrades to browser mode when no install path is available", () => {
  const state = classifyInstallExperience({
    displayModeStandalone: false,
    navigatorStandalone: false,
    platform: "MacIntel",
    maxTouchPoints: 0,
  });
  if (state !== "unavailable") throw new Error(`expected unavailable, received ${state}`);
});
