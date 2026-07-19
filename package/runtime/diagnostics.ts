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
 * Runtime-owned observability counters. These describe the framework's storage,
 * subscription, and write machinery and never reference any application schema.
 *
 * For a device-status widget the load-bearing fields are
 * {@link RuntimeDiagnostics.storeStatus}, {@link RuntimeDiagnostics.schemaCompat},
 * `journaledPendingWrites` (the "N changes waiting to sync" count), and
 * `lastWriteDurability`; the remaining counters exist for the development
 * inspector and bug reports.
 */
export type RuntimeDiagnostics = {
  /** Persistent-storage posture: requested, granted with the driver open, or failed. */
  storageState: "persistent-requested" | "persistent-driver-open" | "failed";
  /** The boot failure the runtime is stuck on, or `null` when boot succeeded. */
  startupFailure: RuntimeStartupFailure | null;
  /** Whether the configured store answered; feeds connected/unreachable UI. */
  storeStatus: RuntimeStoreStatus;
  /** The schema gate's verdict; `data-ahead` means this device is read-only. */
  schemaCompat: SchemaCompatState;
  /** Storage clients opened since page load, runtime recreations included. */
  clientsCreated: number;
  /** Storage clients currently open; one for a healthy runtime. */
  activeClients: number;
  /** Mounted subscribers across live-query and table stores. */
  activeConsumers: number;
  /** Engine subscriptions currently open to feed those consumers. */
  activeVendorSubscriptions: number;
  /** Engine subscriptions opened since page load. */
  totalVendorSubscriptions: number;
  /** Engine mutation-error listeners currently attached. */
  activeMutationListeners: number;
  /** Engine mutation-error listeners attached since page load. */
  totalMutationListeners: number;
  /** Engine subscription teardowns performed since page load. */
  unsubscribeCalls: number;
  /** Writes whose local-durability wait completed. */
  localWaitCalls: number;
  /** Writes currently awaiting local durability. */
  pendingLocalWrites: number;
  /** Writes currently awaiting the store's confirmation. */
  pendingGlobalWrites: number;
  /**
   * The most recent write's deepest durability: `local` is saved on this
   * device, `global` is confirmed by the store.
   */
  lastWriteDurability: "none" | "local" | "global" | "failed";
  /** Writes refused or rejected since boot, including guard refusals. */
  mutationErrors: number;
  /** Journaled writes that have not yet settled as synced or rejected. */
  journaledPendingWrites: number;
  /** Pending writes whose declared intent lifespan has passed (surfacing only). */
  expiredPendingWrites: number;
  /** Effect handler invocations that threw; failed obligations re-arm at boot. */
  effectHandlerFailures: number;
  /** Obligations retired because their delivery window closed undelivered. */
  expiredObligations: number;
  /** Obligations quarantined after repeated handler failures. */
  quarantinedObligations: number;
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
    expiredPendingWrites: 0,
    effectHandlerFailures: 0,
    expiredObligations: 0,
    quarantinedObligations: 0,
    effectLog: [],
  };
}
