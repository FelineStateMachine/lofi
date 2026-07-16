import { BrowserAuthSecretStore, createDb, type Db } from "jazz-tools";
import { referenceApp } from "../app.ts";
import { AuthError } from "./auth.ts";
import { createDiagnostics, type RuntimeDiagnostics } from "./diagnostics.ts";
import { appId, databaseConfig, serverUrl } from "./config.ts";
import { assertDurableBrowser } from "./device-capabilities.ts";
import {
  createTableStore,
  type TableHandle,
  type TableRow,
  type TableStore,
} from "./table-store.ts";
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
  diagnostics: RuntimeDiagnostics;
  /**
   * A reactive store bound to one declared table. Repeated calls with the same
   * table return the same store, so every consumer shares one subscription.
   */
  store<T extends TableRow, Init>(table: TableHandle<T, Init>): TableStore<T, Init>;
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
    diagnostics: createDiagnostics(),
    diagnosticListeners: new Set(),
  };
  return browserGlobal[slotName];
}

function notifyDiagnostics(state = slot()): void {
  for (const listener of state.diagnosticListeners) listener();
}

// "device-local": a random per-device secret, created on demand — identity
// never waits. "device-passkey" (default): the passkey is the account, so the
// secret is derived from the credential's PRF and cached. Booting the database
// waits for that cached secret; the auth gate (see `session.ts`) runs the
// passkey ceremony on a user gesture, saves the secret, and recreates the
// runtime. Return boots find the cached secret and open without a ceremony.
async function resolveAccountSecret(): Promise<string> {
  if (referenceApp.identity !== "device-passkey") {
    return await BrowserAuthSecretStore.getOrCreateSecret({ appId });
  }
  const cached = await BrowserAuthSecretStore.loadSecret({ appId });
  if (cached) return cached;
  throw new AuthError("credential-missing", "Sign in with your passkey to open your account.");
}

async function createClient(state: RuntimeSlot): Promise<Db> {
  try {
    assertDurableBrowser();
    const secret = await resolveAccountSecret();
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
  const stores = new Map<object, TableStore<TableRow, unknown>>();
  let active = true;
  const runtime: LofiRuntime = {
    db,
    diagnostics: state.diagnostics,
    store<T extends TableRow, Init>(table: TableHandle<T, Init>): TableStore<T, Init> {
      let store = stores.get(table);
      if (!store) {
        store = createTableStore(db, table, state.diagnostics, {
          syncConfigured: Boolean(serverUrl),
          onDiagnosticsChange: () => notifyDiagnostics(state),
        }) as TableStore<TableRow, unknown>;
        stores.set(table, store);
      }
      return store as unknown as TableStore<T, Init>;
    },
    shutdown() {
      if (!active) return Promise.resolve();
      active = false;
      for (const store of stores.values()) store.close();
      stores.clear();
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
