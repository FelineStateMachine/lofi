import { waitForActivation } from "./pwa.ts";

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
