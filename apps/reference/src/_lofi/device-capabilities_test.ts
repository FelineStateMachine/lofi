import { DurableStorageUnsupportedError } from "./device-capabilities.ts";
import { assert } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

test("unsupported durable storage names missing capabilities and the stable-origin action", () => {
  const error = new DurableStorageUnsupportedError({
    secureContext: false,
    opfs: false,
    sharedWorker: false,
    webLocks: false,
    messageChannel: false,
    durableDriverSupported: false,
    webAuthn: false,
    prf: "unavailable",
    displayMode: "browser",
  });
  assert(error.name === "DurableStorageUnsupportedError", "durability error needs a stable name");
  for (
    const capability of [
      "secureContext",
      "opfs",
      "sharedWorker",
      "webLocks",
      "messageChannel",
    ]
  ) {
    assert(error.message.includes(capability), `durability error omitted ${capability}`);
  }
  assert(
    error.message.includes("stable HTTPS device URL"),
    "durability error omitted the stable-origin remediation",
  );
});
