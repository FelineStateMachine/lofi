import { activeServerUrl, syncing } from "./config.ts";
// Package-owned development probe.
import { readDeviceCapabilityReport } from "./device-capabilities.ts";
import { type InspectorAdapter, type InspectorSnapshot, mountInspector } from "./inspector.ts";
import { getForegroundRecoveryState, subscribeForegroundRecovery } from "./lifecycle.ts";
import {
  getRuntime,
  getRuntimeDiagnostics,
  reloadBrowserRuntime,
  subscribeRuntimeDiagnostics,
} from "./runtime.ts";
import { isTransportPausedByInspector, setTransportPausedByInspector } from "./transport-gate.ts";

export type LofiDevelopmentBridge = InspectorAdapter;

type LofiDevelopmentGlobal = typeof globalThis & {
  __LOFI_INSPECTOR__?: LofiDevelopmentBridge;
};

const stateListeners = new Set<() => void>();

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
      startupFailure: diagnostics.startupFailure?.code ?? "none",
    },
    sync: {
      mode: activeServerUrl() ? "managed configured" : "local-only",
      transport: activeServerUrl()
        ? isTransportPausedByInspector() ? "paused by inspector" : "live detail unavailable"
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
      transportDetail: activeServerUrl() ? "live detail unavailable" : "not configured",
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
    if (!activeServerUrl()) {
      throw new Error("Cloud transport pause is unavailable in local-only mode");
    }
    const runtime = await getRuntime();
    // Record the pause before touching the transport so foreground recovery
    // cannot race a reconnect in between and silently override the inspector.
    setTransportPausedByInspector(paused);
    try {
      if (paused) await runtime.db.disconnect();
      else await runtime.db.reconnect();
    } catch (error) {
      setTransportPausedByInspector(!paused);
      throw error;
    }
    notifyState();
  },
  restartClient() {
    // The shutdown-then-navigate boundary is the supported clean-runtime path
    // for the pinned Jazz alpha; reloading without it leaves the persistent
    // worker attached during navigation.
    return reloadBrowserRuntime();
  },
  async clearLocalReplica() {
    const runtime = await getRuntime();
    await runtime.db.deleteClientStorage();
    return await reloadBrowserRuntime();
  },
};

if (typeof document !== "undefined") {
  (globalThis as LofiDevelopmentGlobal).__LOFI_INSPECTOR__ = bridge;
  const mounted = mountInspector(bridge);
  import.meta.hot?.dispose(() => {
    mounted.dispose();
    delete (globalThis as LofiDevelopmentGlobal).__LOFI_INSPECTOR__;
  });
}
