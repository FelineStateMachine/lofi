import { IncompatibleBrowserBrokerConfigurationError } from "jazz-tools";
import { defineLofiApp, LofiConfigurationError } from "./app.ts";
import { databaseConfig } from "./config.ts";
import { DurableStorageUnsupportedError } from "./device-capabilities.ts";
import {
  classifyRuntimeStartupFailure,
  createBrokerIncompatibilityHandler,
  reloadAfterRuntimeStartupFailure,
  runRuntimeStartup,
  RuntimeStartupError,
  type RuntimeStartupFailure,
} from "./startup-recovery.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

defineLofiApp({
  name: "startup-recovery-test",
  databaseName: "startup-recovery",
  schema: {},
  storage: "durable",
  sync: { adapter: "jazz" },
});

for (const mode of ["local", "managed"] as const) {
  Deno.test(`persistent ${mode} configuration owns incompatible broker recovery`, async () => {
    const failures: RuntimeStartupFailure[] = [];
    const handler = createBrokerIncompatibilityHandler(mode, (failure) => failures.push(failure));
    const config = databaseConfig("test-secret", "account", mode, false, handler);
    assert(
      config.onIncompatibleBrowserBrokerConfiguration === handler,
      `${mode} persistent configuration omitted the package callback`,
    );
    const vendorError = new IncompatibleBrowserBrokerConfigurationError("vendor detail");

    let rejection: unknown;
    try {
      await runRuntimeStartup(mode, () => {
        config.onIncompatibleBrowserBrokerConfiguration?.(vendorError);
        return Promise.reject(vendorError);
      }, (failure) => failures.push(failure));
    } catch (error) {
      rejection = error;
    }

    assert(rejection instanceof RuntimeStartupError, "startup rejection was swallowed or leaked");
    assert(
      rejection.code === "broker-incompatible",
      "vendor error leaked past stable classification",
    );
    assert(rejection.failure.runtimeMode === mode, "runtime mode was classified incorrectly");
    assert(
      failures.every((failure) =>
        failure.code === "broker-incompatible" && failure.runtimeMode === mode
      ),
      "callback exposed an unstable failure",
    );
    assert(
      !rejection.message.includes("vendor detail"),
      "vendor callback detail reached public error",
    );
  });
}

Deno.test("startup failures distinguish capability, configuration, and storage errors", () => {
  const unsupported = new DurableStorageUnsupportedError({
    secureContext: true,
    opfs: false,
    sharedWorker: true,
    webLocks: true,
    messageChannel: true,
    durableDriverSupported: false,
    webAuthn: true,
    prf: "unknown",
    displayMode: "browser",
  });
  const cases = [
    [unsupported, "unsupported-capabilities"],
    [new LofiConfigurationError("bad author config"), "configuration-error"],
    [new Error("raw storage error"), "storage-startup-failed"],
  ] as const;
  for (const [error, expected] of cases) {
    const failure = classifyRuntimeStartupFailure(error, "local");
    assert(failure.code === expected, `${expected} was classified as ${failure.code}`);
    assert(!failure.message.includes(error.message), `${expected} exposed raw error detail`);
  }
});

Deno.test("broker recovery reloads only after the explicit action", () => {
  let reloads = 0;
  const reload = () => reloads += 1;
  assert(reloads === 0, "recovery reloaded before user action");
  reloadAfterRuntimeStartupFailure(reload);
  assert(Number(reloads) === 1, "explicit recovery action did not reload exactly once");
});
