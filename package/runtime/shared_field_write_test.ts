// The write-side sealer: shared columns seal with the newest held
// generation, resolve their scope from the sibling group column (or a
// fetched row for updates), refuse without a key, and pass pre-sealed and
// non-shared values through untouched.
import { sealSharedColumnValues, sealSharedColumnValuesSync } from "./shared-field-write.ts";
import { clearEncryptedColumnRegistry, registerEncryptedColumns } from "../schema/encrypted.ts";
import { clearSharedColumnRegistry, registerSharedColumn } from "../schema/shared-registry.ts";
import {
  clearSharedFieldKeys,
  installSharedFieldKey,
  sharedKeyScope,
} from "../schema/shared-keyring.ts";
import { generateFieldKey, openSharedValue, SharedFieldError } from "../schema/shared-crypto.ts";
import { assert } from "./test-assert.ts";

const LABEL = "writer.docs.body";

function arrange(): Uint8Array {
  clearEncryptedColumnRegistry();
  clearSharedColumnRegistry();
  clearSharedFieldKeys();
  registerEncryptedColumns({
    docs: { body: { __marker: true } },
  });
  // The harvest walks builder tags; register directly for the unit scope.
  registerSharedColumn({
    label: LABEL,
    kind: "text",
    group: "workspaces",
    groupIdColumn: "workspaceId",
    keys: "workspaceFieldKeys",
    directory: "keyDirectory",
  });
  const fieldKey = generateFieldKey();
  installSharedFieldKey(sharedKeyScope("workspaces", "ws-1"), 1, fieldKey);
  installSharedFieldKey(sharedKeyScope("workspaces", "ws-1"), 3, fieldKey);
  return fieldKey;
}

function cleanup(): void {
  clearEncryptedColumnRegistry();
  clearSharedColumnRegistry();
  clearSharedFieldKeys();
}

// registerEncryptedColumns tags via builder symbols; the unit registry needs
// the (table, column, label) mapping directly, so stub the tag lookup by
// registering through the real harvest with a tagged builder object.
import { encryptedText } from "../schema/encrypted.ts";
function registerDocsBody(): void {
  clearEncryptedColumnRegistry();
  const tagged = encryptedText(LABEL);
  registerEncryptedColumns({ docs: { body: tagged } });
}

Deno.test("inserts seal with the newest held generation", () => {
  const fieldKey = arrange();
  registerDocsBody();
  try {
    const sealed = sealSharedColumnValuesSync("docs", {
      workspaceId: "ws-1",
      title: "plain",
      body: "shared words",
    });
    const stored = sealed.body as string;
    assert(stored.startsWith("encs1.workspaces.ws-1.3."), "the newest generation must seal");
    assert(sealed.title === "plain", "plaintext columns pass through");
    assert(
      openSharedValue({ stored, fieldKey, label: LABEL }) === "shared words",
      "the sealed value must open under the field key",
    );
    // Idempotence: an already-sealed value passes through.
    const again = sealSharedColumnValuesSync("docs", { workspaceId: "ws-1", body: stored });
    assert(again.body === stored, "a pre-sealed value must pass through");
  } finally {
    cleanup();
  }
});

Deno.test("writes without a key or scope refuse loudly", () => {
  arrange();
  registerDocsBody();
  try {
    let pending = false;
    try {
      sealSharedColumnValuesSync("docs", { workspaceId: "ws-other", body: "x" });
    } catch (error) {
      pending = error instanceof SharedFieldError && error.code === "key-pending";
    }
    assert(pending, "a scope without a held key must refuse with key-pending");

    let unscoped = false;
    try {
      sealSharedColumnValuesSync("docs", { body: "x" });
    } catch (error) {
      unscoped = error instanceof SharedFieldError && error.code === "unscoped-write";
    }
    assert(unscoped, "a patch without the group column must refuse in the sync path");
  } finally {
    cleanup();
  }
});

Deno.test("the async path resolves the scope from the fetched row", async () => {
  const fieldKey = arrange();
  registerDocsBody();
  try {
    const sealed = await sealSharedColumnValues(
      "docs",
      { body: "patched words" },
      () => Promise.resolve({ id: "row-1", workspaceId: "ws-1" }),
    );
    const stored = sealed.body as string;
    assert(stored.startsWith("encs1.workspaces.ws-1.3."), "the fetched scope must seal");
    assert(
      openSharedValue({ stored, fieldKey, label: LABEL }) === "patched words",
      "the update seal must open",
    );

    // Tables without shared columns pass through untouched.
    const untouched = await sealSharedColumnValues("elsewhere", { body: "x" });
    assert(untouched.body === "x", "non-shared tables must pass through");
  } finally {
    cleanup();
  }
});
