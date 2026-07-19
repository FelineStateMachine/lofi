// Shared-column contract: state-valued reads over the keyring (pending →
// ready without redefinition), the unscoped-write guard, and keyring
// bookkeeping.
import {
  clearSharedFieldKeys,
  getSharedFieldKey,
  installSharedFieldKey,
  latestSharedFieldGeneration,
  sharedKeyScope,
  subscribeSharedKeyring,
} from "./shared-keyring.ts";
import { generateFieldKey, sealSharedValue, SharedFieldError } from "./shared-crypto.ts";
import {
  sharedEncryptedText,
  sharedFieldReady,
  type SharedFieldValue,
  unwrapSharedField,
} from "./shared-encrypted.ts";
import { clearSharedColumnRegistry, sharedColumnConfigs } from "./shared-registry.ts";
import { assert } from "../runtime/test-assert.ts";

const OPTIONS = {
  group: "workspaces",
  groupIdColumn: "workspaceId",
  keys: "workspaceFieldKeys",
  directory: "keyDirectory",
} as const;

function transformOf(column: unknown): {
  to: (value: unknown) => string;
  from: (value: string) => unknown;
} {
  const transform = (column as { _transform?: unknown })._transform;
  assert(typeof transform === "object" && transform !== null, "column carries no transform");
  return transform as { to: (value: unknown) => string; from: (value: string) => unknown };
}

Deno.test("the keyring installs, reports generations, and notifies", () => {
  clearSharedFieldKeys();
  const scope = sharedKeyScope("workspaces", "ws-1");
  try {
    assert(getSharedFieldKey(scope, 1) === null, "no key before install");
    assert(latestSharedFieldGeneration(scope) === null, "no generation before install");
    let notified = 0;
    const stop = subscribeSharedKeyring(() => notified += 1);
    const key = generateFieldKey();
    installSharedFieldKey(scope, 1, key);
    installSharedFieldKey(scope, 3, generateFieldKey());
    assert(notified === 2, `install must notify (saw ${notified})`);
    installSharedFieldKey(scope, 1, key);
    assert(notified === 2, "an identical re-install must not re-notify");
    assert(latestSharedFieldGeneration(scope) === 3, "latest generation must win");
    assert(getSharedFieldKey(scope, 1) !== null, "installed keys must resolve");
    stop();
  } finally {
    clearSharedFieldKeys();
  }
});

Deno.test("reads surface pending, then ready once the key installs", () => {
  clearSharedFieldKeys();
  clearSharedColumnRegistry();
  try {
    const column = transformOf(sharedEncryptedText("docs.body", OPTIONS));
    const fieldKey = generateFieldKey();
    const stored = sealSharedValue({
      plaintext: "shared content",
      fieldKey,
      label: "docs.body",
      scope: { groupTable: "workspaces", groupId: "ws-1", generation: 2 },
    });

    const pending = column.from(stored) as SharedFieldValue<string>;
    assert(
      pending.state === "pending-key" && pending.generation === 2,
      `a keyless read must surface pending (saw ${JSON.stringify(pending)})`,
    );
    let threw = false;
    try {
      unwrapSharedField(pending);
    } catch (error) {
      threw = error instanceof SharedFieldError && error.code === "key-pending";
    }
    assert(threw, "unwrapSharedField must throw key-pending while pending");

    installSharedFieldKey(sharedKeyScope("workspaces", "ws-1"), 2, fieldKey);
    const ready = column.from(stored) as SharedFieldValue<string>;
    assert(
      sharedFieldReady(ready) && ready.value === "shared content",
      "the same stored value must decrypt after key install",
    );
    assert(unwrapSharedField(ready) === "shared content", "unwrap must return the value");

    // The wrong key surfaces corrupt, never garbage.
    installSharedFieldKey(sharedKeyScope("workspaces", "ws-1"), 2, generateFieldKey());
    const corrupt = column.from(stored) as SharedFieldValue<string>;
    assert(corrupt.state === "corrupt", "a wrong key must surface corrupt");
    const unprefixed = column.from("plaintext leftovers") as SharedFieldValue<string>;
    assert(unprefixed.state === "corrupt", "a non-sealed stored value must surface corrupt");
  } finally {
    clearSharedFieldKeys();
    clearSharedColumnRegistry();
  }
});

Deno.test("writes pass sealed values and refuse everything else", () => {
  clearSharedColumnRegistry();
  try {
    const column = transformOf(sharedEncryptedText("docs.note", OPTIONS));
    const fieldKey = generateFieldKey();
    const sealed = sealSharedValue({
      plaintext: "x",
      fieldKey,
      label: "docs.note",
      scope: { groupTable: "workspaces", groupId: "ws-1", generation: 1 },
    });
    assert(column.to(sealed) === sealed, "sealed values must pass through");
    let refused = false;
    try {
      column.to("raw plaintext");
    } catch (error) {
      refused = error instanceof SharedFieldError && error.code === "unscoped-write";
    }
    assert(refused, "an unsealed write must refuse with unscoped-write");
  } finally {
    clearSharedColumnRegistry();
  }
});

Deno.test("constructors register their wiring for the runtime", () => {
  clearSharedColumnRegistry();
  try {
    sharedEncryptedText("docs.registered", OPTIONS);
    const configs = sharedColumnConfigs();
    assert(
      configs.length === 1 && configs[0].label === "docs.registered" &&
        configs[0].keys === "workspaceFieldKeys" && configs[0].directory === "keyDirectory",
      "the constructor must record its configuration",
    );
  } finally {
    clearSharedColumnRegistry();
  }
});
