// Package contract tests for the durable namespace election record.
import {
  completeLocalRowMigration,
  electManagedNamespace,
  readNamespaceState,
} from "./namespace-state.ts";
import { appId } from "./config.ts";
import { assert } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

const stateKey = `lofi:namespace-state:${appId}`;
const legacyManagedKey = `lofi:managed-runtime:${appId}`;
const legacyMigrateKey = `lofi:migrate-local-rows:${appId}`;
const allKeys = [stateKey, legacyManagedKey, legacyMigrateKey];

// Deno persists localStorage across test files and runs, so every test starts
// from explicitly cleared election keys and leaves none behind.
function withCleanStorage(body: () => void): () => void {
  return () => {
    for (const key of allKeys) localStorage.removeItem(key);
    try {
      body();
    } finally {
      for (const key of allKeys) localStorage.removeItem(key);
    }
  };
}

test(
  "first boot elects the local namespace with no pending migration",
  withCleanStorage(() => {
    const state = readNamespaceState();
    assert(state.mode === "local", "a device without an election must boot local");
    assert(!state.migrateLocalRows, "a local device has nothing to migrate");
  }),
);

test(
  "electing managed records mode and migration in one atomic record",
  withCleanStorage(() => {
    electManagedNamespace({ migrateLocalRows: true });
    const state = readNamespaceState();
    assert(state.mode === "managed", "election must switch the namespace to managed");
    assert(state.migrateLocalRows, "a local-to-managed transition must schedule migration");
    assert(
      localStorage.getItem(stateKey) !== null && localStorage.getItem(legacyManagedKey) === null,
      "election must write the single record, never the legacy split flags",
    );
  }),
);

test(
  "completing migration clears only the pending flag",
  withCleanStorage(() => {
    electManagedNamespace({ migrateLocalRows: true });
    completeLocalRowMigration();
    const state = readNamespaceState();
    assert(state.mode === "managed", "completion must not change the elected namespace");
    assert(!state.migrateLocalRows, "completion must clear the pending migration");
  }),
);

test(
  "re-election preserves migration progress in both directions",
  withCleanStorage(() => {
    electManagedNamespace({ migrateLocalRows: true });
    electManagedNamespace({ migrateLocalRows: false });
    assert(
      readNamespaceState().migrateLocalRows,
      "re-election must never clear a pending migration",
    );
    completeLocalRowMigration();
    electManagedNamespace({ migrateLocalRows: true });
    assert(
      !readNamespaceState().migrateLocalRows,
      "re-election must never resurrect a completed migration",
    );
  }),
);

test(
  "legacy split flags upgrade to the record and are removed",
  withCleanStorage(() => {
    localStorage.setItem(legacyManagedKey, "1");
    localStorage.setItem(legacyMigrateKey, "1");
    const state = readNamespaceState();
    assert(state.mode === "managed", "a legacy managed election must survive the upgrade");
    assert(state.migrateLocalRows, "a legacy pending migration must survive the upgrade");
    assert(
      localStorage.getItem(legacyManagedKey) === null &&
        localStorage.getItem(legacyMigrateKey) === null,
      "the upgrade must retire the legacy keys",
    );
    assert(
      localStorage.getItem(stateKey) !== null,
      "the upgrade must persist the consolidated record",
    );
  }),
);

test(
  "a corrupted record falls back to the local first-boot state",
  withCleanStorage(() => {
    localStorage.setItem(stateKey, "{not json");
    const state = readNamespaceState();
    assert(state.mode === "local", "an unreadable record must never elect managed");
    assert(!state.migrateLocalRows, "an unreadable record must never schedule migration");
  }),
);
