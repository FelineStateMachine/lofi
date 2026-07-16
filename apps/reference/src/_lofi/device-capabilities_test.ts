import { classifyCredentialOrigin, DurableStorageUnsupportedError } from "./device-capabilities.ts";
import { assert } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

test("unsupported durable storage names missing capabilities and the stable-origin action", () => {
  const error = new DurableStorageUnsupportedError({
    secureContext: false,
    serviceWorker: false,
    opfs: false,
    sharedWorker: false,
    webLocks: false,
    messageChannel: false,
    durableDriverSupported: false,
    credentialOrigin: {
      status: "blocked",
      rpId: "192.0.2.1",
      action: "use the stable HTTPS URL printed by `deno task --tunnel dev`",
    },
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

test("Deno Tunnel and nzip hostnames are stable credential origins", () => {
  for (
    const origin of [
      "https://lofi-dev.example.deno.net/",
      "https://2c6d.n.zip/",
    ]
  ) {
    const report = classifyCredentialOrigin(new URL(origin));
    assert(report.status === "stable", `${origin} was not classified as stable`);
    assert(
      report.rpId === new URL(origin).hostname,
      `${origin} did not preserve location.hostname`,
    );
  }
});

test("local, insecure, and custom origins cannot silently enroll credentials", () => {
  const local = classifyCredentialOrigin(new URL("http://localhost:4321/"));
  const insecure = classifyCredentialOrigin(new URL("http://phone.lan:4321/"));
  const custom = classifyCredentialOrigin(new URL("https://app.example.com/"));
  assert(local.status === "local-only", "localhost should remain local-only");
  assert(insecure.status === "blocked", "insecure device origin should be blocked");
  assert(custom.status === "unverified", "custom origin should require a permanence decision");
  for (const report of [local, insecure, custom]) {
    assert(report.action.includes("credential"), `${report.status} omitted credential remediation`);
  }
});
