import type { SchemaCompatState } from "./schema-compat.ts";
import type { RuntimeStartupFailure } from "./startup-recovery.ts";
import type { RuntimeStoreStatus } from "./store-status.ts";

/** One structured entry recorded by the built-in `s.log` effect unit. */
export type EffectLogEntry = {
  /** The author-chosen log label. */
  label: string;
  /** The declaring verb's name, or `null` for writes without a verb. */
  verb: string | null;
  /** The written table's name. */
  table: string;
  /** The written row's id. */
  rowId: string;
  /** Which fate settled the write. */
  fate: "synced" | "rejected";
  /** Epoch milliseconds when the entry was recorded. */
  at: number;
};

// Recent-entry window for the s.log diagnostic feed.
const maxEffectLogEntries = 20;

/** Appends one `s.log` entry, keeping the bounded recent window. */
export function recordEffectLogEntry(
  diagnostics: RuntimeDiagnostics,
  entry: EffectLogEntry,
): void {
  diagnostics.effectLog = [...diagnostics.effectLog.slice(-(maxEffectLogEntries - 1)), entry];
}

/**
// Package-owned runtime diagnostics.
 * Runtime-owned observability counters. These describe the framework's storage,
 * subscription, and write machinery and never reference any application schema.
 */
export type RuntimeDiagnostics = {
  storageState: "persistent-requested" | "persistent-driver-open" | "failed";
  startupFailure: RuntimeStartupFailure | null;
  storeStatus: RuntimeStoreStatus;
  schemaCompat: SchemaCompatState;
  clientsCreated: number;
  activeClients: number;
  activeConsumers: number;
  activeVendorSubscriptions: number;
  totalVendorSubscriptions: number;
  activeMutationListeners: number;
  totalMutationListeners: number;
  unsubscribeCalls: number;
  localWaitCalls: number;
  pendingLocalWrites: number;
  pendingGlobalWrites: number;
  lastWriteDurability: "none" | "local" | "global" | "failed";
  mutationErrors: number;
  /** Journaled writes that have not yet settled as synced or rejected. */
  journaledPendingWrites: number;
  /** Effect handler invocations that threw; failed obligations re-arm at boot. */
  effectHandlerFailures: number;
  /** Recent structured entries recorded by the built-in `s.log` effect unit. */
  effectLog: readonly EffectLogEntry[];
};

export function createDiagnostics(): RuntimeDiagnostics {
  return {
    storageState: "persistent-requested",
    startupFailure: null,
    storeStatus: { state: "unchecked", reason: "sync-not-connected" },
    schemaCompat: { state: "unchecked", reason: "inactive" },
    clientsCreated: 0,
    activeClients: 0,
    activeConsumers: 0,
    activeVendorSubscriptions: 0,
    totalVendorSubscriptions: 0,
    activeMutationListeners: 0,
    totalMutationListeners: 0,
    unsubscribeCalls: 0,
    localWaitCalls: 0,
    pendingLocalWrites: 0,
    pendingGlobalWrites: 0,
    lastWriteDurability: "none",
    mutationErrors: 0,
    journaledPendingWrites: 0,
    effectHandlerFailures: 0,
    effectLog: [],
  };
}
