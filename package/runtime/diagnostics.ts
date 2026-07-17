import type { RuntimeStartupFailure } from "./startup-recovery.ts";

/**
// Package-owned runtime diagnostics.
 * Runtime-owned observability counters. These describe the framework's storage,
 * subscription, and write machinery and never reference any application schema.
 */
export type RuntimeDiagnostics = {
  storageState: "persistent-requested" | "persistent-driver-open" | "failed";
  startupFailure: RuntimeStartupFailure | null;
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
};

export function createDiagnostics(): RuntimeDiagnostics {
  return {
    storageState: "persistent-requested",
    startupFailure: null,
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
  };
}
