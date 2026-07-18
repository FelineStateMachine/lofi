/**
 * Package-owned namespace election state.
 *
 * One durable record decides which database namespace the runtime opens — the
 * zero-ceremony local namespace of first boot, or the managed namespace that
 * can attach sync — and whether rows written locally still need to migrate
 * across. The record lives in a single localStorage key written atomically,
 * and this module is its only reader and writer, so session election, account
 * restore, and runtime startup always observe one consistent state instead of
 * coordinating separate flags.
 *
 * @module
 */

import { appId } from "./config.ts";

/** Which namespace the runtime opens, and whether local rows still need copying. */
export type NamespaceState = {
  /** `local` is the first-boot namespace; `managed` is the one that can attach sync. */
  mode: "local" | "managed";
  /** True while rows written in the local namespace still need copying into managed. */
  migrateLocalRows: boolean;
};

const stateKey = `lofi:namespace-state:${appId}`;
// Split flags written by earlier releases; upgraded to the single record on first read.
const legacyManagedKey = `lofi:managed-runtime:${appId}`;
const legacyMigrateKey = `lofi:migrate-local-rows:${appId}`;

function firstBoot(): NamespaceState {
  return { mode: "local", migrateLocalRows: false };
}

function parseState(raw: string | null): NamespaceState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<NamespaceState> | null;
    if (value && (value.mode === "local" || value.mode === "managed")) {
      return { mode: value.mode, migrateLocalRows: value.migrateLocalRows === true };
    }
  } catch {
    // An unreadable record is treated as absent below.
  }
  return null;
}

function writeState(state: NamespaceState): void {
  try {
    localStorage.setItem(stateKey, JSON.stringify(state));
  } catch {
    // A private-mode storage failure leaves the previous election in place.
  }
}

/** Reads the durable namespace election, upgrading legacy split flags in place. */
export function readNamespaceState(): NamespaceState {
  if (typeof localStorage === "undefined") return firstBoot();
  try {
    const recorded = parseState(localStorage.getItem(stateKey));
    if (recorded) return recorded;
    if (localStorage.getItem(legacyManagedKey) === "1") {
      const upgraded: NamespaceState = {
        mode: "managed",
        migrateLocalRows: localStorage.getItem(legacyMigrateKey) === "1",
      };
      writeState(upgraded);
      localStorage.removeItem(legacyManagedKey);
      localStorage.removeItem(legacyMigrateKey);
      return upgraded;
    }
    return firstBoot();
  } catch {
    return firstBoot();
  }
}

/**
 * Elects the managed namespace in one atomic write. A device transitioning
 * from local mode records whether its local rows must migrate; a device that
 * is already managed keeps its current migration progress, so re-election can
 * neither clear a pending migration nor resurrect a completed one.
 */
export function electManagedNamespace(options: { migrateLocalRows: boolean }): void {
  if (typeof localStorage === "undefined") return;
  const current = readNamespaceState();
  writeState({
    mode: "managed",
    migrateLocalRows: current.mode === "managed"
      ? current.migrateLocalRows
      : options.migrateLocalRows,
  });
}

/** Records that every local row now exists in the managed namespace. */
export function completeLocalRowMigration(): void {
  if (typeof localStorage === "undefined") return;
  const current = readNamespaceState();
  if (current.mode === "managed" && current.migrateLocalRows) {
    writeState({ mode: "managed", migrateLocalRows: false });
  }
}
