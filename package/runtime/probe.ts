import { serverUrl, syncing } from "./config.ts";
// Package-owned development probe.
import { readDeviceCapabilityReport } from "./device-capabilities.ts";
import { type InspectorAdapter, type InspectorSnapshot, mountInspector } from "./inspector.ts";
import { getForegroundRecoveryState, subscribeForegroundRecovery } from "./lifecycle.ts";
import { getRuntime, getRuntimeDiagnostics, subscribeRuntimeDiagnostics } from "./runtime.ts";

export type LofiDevelopmentBridge = InspectorAdapter;

declare global {
  interface Window {
    __LOFI_INSPECTOR__?: LofiDevelopmentBridge;
  }
}

const stateListeners = new Set<() => void>();
let transportPaused = false;

function reloadBrowserClient(): Promise<void> {
  globalThis.location.reload();
  // The current document must not report completion while its replacement is
  // still booting. Navigation destroys this pending promise with the page.
  return new Promise(() => undefined);
}

function notifyState(): void {
  for (const listener of stateListeners) listener();
}

async function readSnapshot(): Promise<InspectorSnapshot> {
  const [runtime, device] = await Promise.all([
    getRuntime(),
    readDeviceCapabilityReport(),
  ]);
  const diagnostics = getRuntimeDiagnostics();
  const lifecycle = getForegroundRecoveryState();
  const authMode = runtime.db.getAuthState().authMode;
  return {
    identity: {
      state: authMode === "local-first"
        ? "device-local key active"
        : authMode === "external"
        ? "external"
        : authMode === "anonymous"
        ? "anonymous"
        : "unavailable",
      backup: syncing() ? "recovery phrase" : "local-only",
    },
    storage: {
      driver: diagnostics.storageState === "persistent-driver-open"
        ? "persistent open"
        : diagnostics.storageState === "persistent-requested"
        ? "persistent requested"
        : "failed",
      persistence: device.persistentPermission === "not-granted"
        ? "not granted"
        : device.persistentPermission,
      fallback: diagnostics.storageState === "failed" ? "unavailable" : "none",
    },
    sync: {
      mode: serverUrl ? "managed configured" : "local-only",
      transport: serverUrl
        ? transportPaused ? "paused by inspector" : "live detail unavailable"
        : "not configured",
      pendingLocalWrites: diagnostics.pendingLocalWrites,
      pendingGlobalWrites: diagnostics.pendingGlobalWrites,
      lastWrite: diagnostics.lastWriteDurability,
    },
    runtime: {
      clients: diagnostics.activeClients,
      consumers: diagnostics.activeConsumers,
      vendorSubscriptions: diagnostics.activeVendorSubscriptions,
      mutationListeners: diagnostics.activeMutationListeners,
      mutationErrors: diagnostics.mutationErrors,
    },
    lifecycle: {
      ...lifecycle,
      transportDetail: serverUrl ? "live detail unavailable" : "not configured",
    },
    multiTab: {
      role: "unavailable",
      detail: "Jazz alpha.53 exposes no supported leader/follower signal",
    },
  };
}

const bridge: LofiDevelopmentBridge = {
  readSnapshot,
  subscribe(listener) {
    stateListeners.add(listener);
    const unsubscribeRuntime = subscribeRuntimeDiagnostics(listener);
    const unsubscribeLifecycle = subscribeForegroundRecovery(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      stateListeners.delete(listener);
      unsubscribeRuntime();
      unsubscribeLifecycle();
    };
  },
  async setTransportPaused(paused) {
    if (!serverUrl) {
      throw new Error("Cloud transport pause is unavailable in local-only mode");
    }
    const runtime = await getRuntime();
    if (paused) await runtime.db.disconnect();
    else await runtime.db.reconnect();
    transportPaused = paused;
    notifyState();
  },
  restartClient() {
    return reloadBrowserClient();
  },
  async clearLocalReplica() {
    const runtime = await getRuntime();
    await runtime.db.deleteClientStorage();
    return await reloadBrowserClient();
  },
};

if (typeof document !== "undefined") {
  (globalThis as typeof globalThis & Window).__LOFI_INSPECTOR__ = bridge;
  const mounted = mountInspector(bridge);
  import.meta.hot?.dispose(() => {
    mounted.dispose();
    delete (globalThis as typeof globalThis & Window).__LOFI_INSPECTOR__;
  });
}
