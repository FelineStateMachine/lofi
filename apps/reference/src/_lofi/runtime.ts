import { BrowserAuthSecretStore, createDb, type Db } from "jazz-tools";
import { ChecklistStore, type RuntimeDiagnostics } from "./checklist-store.ts";
import { appId, databaseConfig } from "./config.ts";
import { assertDurableBrowser } from "./device-capabilities.ts";
import {
  AdapterLifecycle,
  createSerializedResourceState,
  getResource,
  recreateResource,
  type SerializedResourceState,
  shutdownResource,
} from "./resource-lifecycle.ts";

export type LofiRuntime = {
  db: Db;
  checklist: ChecklistStore;
  diagnostics: RuntimeDiagnostics;
  shutdown(): Promise<void>;
};

export const runtimeRecreatedEvent = "lofi:runtime-recreated";

type RuntimeSlot = {
  client: SerializedResourceState<Db>;
  diagnostics: RuntimeDiagnostics;
  diagnosticListeners: Set<() => void>;
};

const slotName = "__LOFI_ALPHA53_RUNTIME__";
const browserGlobal = globalThis as typeof globalThis & { [slotName]?: RuntimeSlot };

function slot(): RuntimeSlot {
  browserGlobal[slotName] ??= {
    client: createSerializedResourceState<Db>(),
    diagnostics: {
      storageState: "persistent-requested",
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
    },
    diagnosticListeners: new Set(),
  };
  return browserGlobal[slotName];
}

function notifyDiagnostics(state = slot()): void {
  for (const listener of state.diagnosticListeners) listener();
}

async function createClient(state: RuntimeSlot): Promise<Db> {
  try {
    assertDurableBrowser();
    const secret = await BrowserAuthSecretStore.getOrCreateSecret({ appId });
    const db = await createDb(databaseConfig(secret));
    state.diagnostics.storageState = "persistent-driver-open";
    state.diagnostics.clientsCreated += 1;
    state.diagnostics.activeClients += 1;
    notifyDiagnostics(state);
    return db;
  } catch (error) {
    state.diagnostics.storageState = "failed";
    throw error;
  }
}

async function destroyClient(state: RuntimeSlot, db: Db): Promise<void> {
  await db.shutdown();
  state.diagnostics.activeClients -= 1;
  notifyDiagnostics(state);
}

const adapter = new AdapterLifecycle<Db, LofiRuntime>();
let recreationPromise: Promise<LofiRuntime> | null = null;
let shutdownPromise: Promise<void> | null = null;

function attachRuntime(state: RuntimeSlot, db: Db): LofiRuntime {
  const checklist = new ChecklistStore(
    db,
    state.diagnostics,
    undefined,
    () => notifyDiagnostics(state),
  );
  const stopMutationErrors = db.onMutationError((event) => checklist.reportMutationError(event));
  state.diagnostics.activeMutationListeners += 1;
  state.diagnostics.totalMutationListeners += 1;
  notifyDiagnostics(state);
  let active = true;
  const runtime: LofiRuntime = {
    db,
    checklist,
    diagnostics: state.diagnostics,
    shutdown() {
      if (!active) return Promise.resolve();
      active = false;
      checklist.close();
      stopMutationErrors();
      state.diagnostics.activeMutationListeners -= 1;
      notifyDiagnostics(state);
      return Promise.resolve();
    },
  };
  return runtime;
}

export function getRuntime(): Promise<LofiRuntime> {
  if (recreationPromise) return recreationPromise;
  const state = slot();
  return adapter.get(
    () => getResource(state.client, () => createClient(state)),
    (db) => attachRuntime(state, db),
  );
}

export function getRuntimeDiagnostics(): RuntimeDiagnostics {
  return { ...slot().diagnostics };
}

export function subscribeRuntimeDiagnostics(listener: () => void): () => void {
  const listeners = slot().diagnosticListeners;
  listeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
  };
}

export function recreateRuntime(): Promise<LofiRuntime> {
  if (recreationPromise) return recreationPromise;
  const state = slot();
  const operation = (async () => {
    await adapter.release((runtime) => runtime.shutdown());
    const db = await recreateResource(
      state.client,
      () => createClient(state),
      (current) => destroyClient(state, current),
    );
    return await adapter.get(() => Promise.resolve(db), (current) => attachRuntime(state, current));
  })();
  const tracked = operation.finally(() => {
    if (recreationPromise === tracked) recreationPromise = null;
  });
  recreationPromise = tracked;
  return tracked;
}

export function shutdownRuntime(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  const state = slot();
  const operation = (async () => {
    await recreationPromise?.catch(() => undefined);
    await adapter.release((runtime) => runtime.shutdown());
    await shutdownResource(state.client, (db) => destroyClient(state, db));
  })();
  const tracked = operation.finally(() => {
    if (shutdownPromise === tracked) shutdownPromise = null;
  });
  shutdownPromise = tracked;
  return tracked;
}

import.meta.hot?.dispose(() => adapter.dispose((runtime) => runtime.shutdown()));
