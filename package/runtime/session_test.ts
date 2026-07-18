// Package contract tests for account-session election behavior.
import { createBackupPasskey, enableSyncBackup } from "./session.ts";
import { readNamespaceState } from "./namespace-state.ts";
import { appId, syncAvailable } from "./config.ts";
import { defineLofiApp } from "./app.ts";
import { assert } from "./test-assert.ts";

defineLofiApp({
  name: "lofi-test",
  databaseName: "lofi-test",
  schema: {},
  storage: "durable",
  credentialOrigins: [],
  sync: { adapter: "jazz" },
});

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

const electionKeys = [
  `lofi:namespace-state:${appId}`,
  `lofi:managed-runtime:${appId}`,
  `lofi:migrate-local-rows:${appId}`,
  `lofi:sync-elected:${appId}`,
];

test("enabling sync without a sync location is the documented no-op", async () => {
  assert(!syncAvailable(), "this contract test requires the unconfigured local build");
  for (const key of electionKeys) localStorage.removeItem(key);
  try {
    const session = await enableSyncBackup();
    assert(!session.backedUp, "no election may be recorded without a managed Jazz app");
    assert(!session.syncing, "nothing can replicate without a managed Jazz app");
    const namespace = readNamespaceState();
    assert(
      namespace.mode === "local" && !namespace.migrateLocalRows,
      "the local namespace must remain elected — a managed election would hide every local row",
    );
    for (const key of electionKeys) {
      assert(
        localStorage.getItem(key) === null,
        `the no-op must not persist election state (wrote ${key})`,
      );
    }
  } finally {
    for (const key of electionKeys) localStorage.removeItem(key);
  }
});

// In Deno there is no `location`, so enrollment fails with `origin-rejected`
// before any WebAuthn surface is touched — exactly the failure class whose
// guard handling these tests pin down.
const phraseGuardKey = `lofi:phrase-passkey:${appId}`;

test("a failed re-enrollment preserves an existing phrase guard", async () => {
  const pinned = JSON.stringify({ id: "AQIDBA" });
  localStorage.setItem(phraseGuardKey, pinned);
  try {
    const guarded = await createBackupPasskey();
    assert(guarded, "the device must still report itself guarded");
    assert(
      localStorage.getItem(phraseGuardKey) === pinned,
      "the pinned guard record must survive a failed re-enrollment",
    );
  } finally {
    localStorage.removeItem(phraseGuardKey);
  }
});

test("a failed first enrollment stores no guard and reports unguarded", async () => {
  localStorage.removeItem(phraseGuardKey);
  const guarded = await createBackupPasskey();
  assert(!guarded, "a device that never enrolled must report unguarded");
  assert(
    localStorage.getItem(phraseGuardKey) === null,
    "no guard record may be written by a failed enrollment",
  );
});
