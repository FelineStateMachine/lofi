// Package contract tests for account-session election behavior.
import { enableSyncBackup } from "./session.ts";
import { readNamespaceState } from "./namespace-state.ts";
import { appId, syncAvailable } from "./config.ts";
import { assert } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

const electionKeys = [
  `lofi:namespace-state:${appId}`,
  `lofi:managed-runtime:${appId}`,
  `lofi:migrate-local-rows:${appId}`,
  `lofi:sync-elected:${appId}`,
];

test("enabling sync without a managed Jazz app is the documented no-op", async () => {
  assert(!syncAvailable, "this contract test requires the unconfigured local build");
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
