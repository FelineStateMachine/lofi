/// <reference path="./env.d.ts" />
import { BrowserAuthSecretStore, createDb, type Db } from "jazz-tools";
// Package-owned Jazz runtime.
import { getLofiApp } from "./app.ts";
import { createDiagnostics, type RuntimeDiagnostics } from "./diagnostics.ts";
import { activeSink, appId, databaseConfig, syncing } from "./config.ts";
import { assertSchemaWritable, schemaCompatGate, subscribeSchemaCompat } from "./schema-compat.ts";
import { resolveStoreStatus } from "./store-status.ts";
import { acquireUpgradeWriteLock } from "./upgrade-coordination.ts";
import { setEncryptedColumnKey } from "../schema/encrypted.ts";
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
  replaceResource,
  type SerializedResourceState,
  shutdownResource,
} from "./resource-lifecycle.ts";
import {
  createBrokerIncompatibilityHandler,
  runRuntimeStartup,
  type RuntimeStartupFailure,
} from "./startup-recovery.ts";
import { completeLocalRowMigration, readNamespaceState } from "./namespace-state.ts";
import { nestedAppTables } from "../schema/nested.ts";

/** The shared, lazily opened Jazz client and its application-facing adapters. */
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

/** Event dispatched after account, sync, or runtime replacement changes active state. */
export const runtimeRecreatedEvent = "lofi:runtime-recreated";

type RuntimeSlot = {
  client: SerializedResourceState<Db>;
  diagnostics: RuntimeDiagnostics;
  diagnosticListeners: Set<() => void>;
  principal: string | null;
  serverConfigured: boolean;
};

const slotName = "__LOFI_ALPHA53_RUNTIME__";
const browserGlobal = globalThis as typeof globalThis & { [slotName]?: RuntimeSlot };

function slot(): RuntimeSlot {
  browserGlobal[slotName] ??= {
    client: createSerializedResourceState<Db>(),
    diagnostics: createDiagnostics(),
    diagnosticListeners: new Set(),
    principal: null,
    serverConfigured: false,
  };
  return browserGlobal[slotName];
}

function notifyDiagnostics(state = slot()): void {
  for (const listener of state.diagnosticListeners) listener();
}

function recordStartupFailure(state: RuntimeSlot, failure: RuntimeStartupFailure): void {
  const previous = state.diagnostics.startupFailure;
  state.diagnostics.storageState = "failed";
  state.diagnostics.startupFailure = failure;
  if (
    previous?.code !== failure.code || previous.runtimeMode !== failure.runtimeMode ||
    previous.message !== failure.message
  ) {
    notifyDiagnostics(state);
  }
}

// Local-first: a random per-device secret, created on demand and cached — so
// the account opens immediately on first boot, offline, with no ceremony. The
// same secret opens the same account whether or not sync is attached, so a
// later election to back up and sync (see `session.ts`) keeps all existing
// data. Recovering from a phrase replaces the cached secret and recreates the
// runtime, so the restored account's synced data opens under the same identity.
async function resolveAccountSecret(): Promise<string> {
  return await BrowserAuthSecretStore.getOrCreateSecret({ appId });
}

async function accountNamespace(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type RuntimeTable = {
  _table: string;
  _schema: Record<string, { columns?: Array<{ name?: string }> }>;
  where(input: Record<string, unknown>): unknown;
};

function runtimeTables(): RuntimeTable[] {
  const appSchema = getLofiApp().schema;
  // A nested app groups its table handles inside namespace objects, which a
  // one-level walk would silently skip; its flattened registry is
  // authoritative. A flat `defineApp` schema keeps the one-level walk.
  const values = nestedAppTables(appSchema) ??
    Object.values(appSchema as Record<string, unknown>);
  return values.filter((value) =>
    value && typeof value === "object" && "_table" in value && "where" in value
  ) as RuntimeTable[];
}

/**
 * Resolves one declared table by name from the active app schema, for
 * package modules that journal writes by table name.
 */
export function findRuntimeTable(
  name: string,
): { where(input: Record<string, unknown>): unknown } | null {
  return runtimeTables().find((table) => table._table === name) ?? null;
}

async function awaitLocalReady(db: Db): Promise<void> {
  const firstTable = runtimeTables()[0];
  if (!firstTable) return;
  // One row proves the persistent bridge is attached; materializing the whole
  // first table on every open pays row-count-proportional startup cost.
  const query = firstTable.where({}) as { limit?: (n: number) => unknown };
  await db.all((query.limit?.(1) ?? query) as never, { tier: "local" });
}

async function migrateLocalRows(
  state: RuntimeSlot,
  db: Db,
  secret: string,
  namespace: string,
): Promise<void> {
  const record = (failure: RuntimeStartupFailure) => recordStartupFailure(state, failure);
  const local = await runRuntimeStartup(
    "local",
    () =>
      createDb(
        databaseConfig(
          secret,
          namespace,
          "local",
          false,
          createBrokerIncompatibilityHandler("local", record),
        ),
      ),
    record,
  );
  await awaitLocalReady(local);
  for (const table of runtimeTables()) {
    const rows = await local.all(table.where({}) as never, { tier: "local" }) as Array<
      Record<string, unknown> & { id: string }
    >;
    const columns = table._schema[table._table]?.columns ?? [];
    for (const row of rows) {
      const values: Record<string, unknown> = {};
      for (const column of columns) {
        if (column.name && column.name in row) values[column.name] = row[column.name];
      }
      // Local-tier durability is the completion bar: it holds offline, so boot
      // never blocks on the network, and the managed client replicates the
      // copied rows globally through normal sync once connected.
      await db.insert(table as never, values as never, { id: row.id }).wait({ tier: "local" });
    }
  }
  completeLocalRowMigration();
  // Keep the read-only source connection until navigation. In alpha.53,
  // shutting down either browser Db can retire the shared broker used by its
  // sibling; the page lifecycle releases both ports safely.
}

// Encrypted columns fail closed until this runs: the master key derives from
// the account secret, so it exists before the first database operation and is
// re-derived whenever the runtime is recreated after a secret change.
async function installEncryptedColumnKey(secret: string): Promise<void> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0) as BufferSource,
      info: new TextEncoder().encode("lofi:encrypted-columns:v1") as BufferSource,
    },
    material,
    256,
  );
  setEncryptedColumnKey(new Uint8Array(bits));
}

async function createClient(state: RuntimeSlot): Promise<Db> {
  const namespaceState = readNamespaceState();
  const connect = syncing();
  const runtimeMode = namespaceState.mode === "managed" || connect ? "managed" : "local";
  const record = (failure: RuntimeStartupFailure) => recordStartupFailure(state, failure);
  state.diagnostics.storageState = "persistent-requested";
  state.diagnostics.startupFailure = null;
  state.diagnostics.storeStatus = { state: "unchecked", reason: "sync-not-connected" };
  notifyDiagnostics(state);
  // The store preflight rides alongside database creation, never in front of
  // it: local-first boot must not wait on the network. resolveStoreStatus maps
  // every failure and timeout to a diagnostic value, so this only records
  // state — a schema-less or drifted store surfaces here at boot instead of as
  // a hanging first write, and is never repaired from here.
  void resolveStoreStatus({ connect, sink: activeSink() }).then((status) => {
    state.diagnostics.storeStatus = status;
    notifyDiagnostics(state);
  });
  return await runRuntimeStartup(runtimeMode, async () => {
    assertDurableBrowser();
    const secret = await resolveAccountSecret();
    await installEncryptedColumnKey(secret);
    const namespace = await accountNamespace(secret);
    const db = await createDb(
      databaseConfig(
        secret,
        namespace,
        runtimeMode,
        connect,
        createBrokerIncompatibilityHandler(runtimeMode, record),
      ),
    );
    // Browser `createDb()` returns before its persistent worker bridge has
    // necessarily attached. A local-tier query is the public readiness barrier;
    // without it, an immediate post-replacement mutation can see no attainable
    // durability tier and be rejected even though OPFS is configured.
    await awaitLocalReady(db);
    // Gate on the namespace record, not on live sync: rows written before the
    // election must reach the managed namespace even when the connection is
    // unavailable, otherwise they sit hidden in the local namespace.
    if (runtimeMode === "managed" && namespaceState.migrateLocalRows) {
      await migrateLocalRows(state, db, secret, namespace);
    }
    state.principal = db.getAuthState().session?.user_id ?? null;
    state.serverConfigured = connect;
    state.diagnostics.storageState = "persistent-driver-open";
    state.diagnostics.startupFailure = null;
    state.diagnostics.clientsCreated += 1;
    state.diagnostics.activeClients += 1;
    // The runtime is open read-write; the compatibility gate may stamp the
    // local schema version forward (it never stamps while data is ahead).
    schemaCompatGate.markRuntimeWritable();
    notifyDiagnostics(state);
    return db;
  }, record);
}

// Shutdown deliberately avoids `logout()`, which would clear local account
// state that must carry forward into a restored or sync-enabled runtime.
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
        // Live callback: stores follow later sync elections and stops without
        // being recreated alongside the runtime.
        store = createTableStore(db, table, state.diagnostics, {
          syncConfigured: syncing,
          onDiagnosticsChange: () => notifyDiagnostics(state),
          guardWrite: async () => {
            await assertSchemaWritable();
            return await acquireUpgradeWriteLock();
          },
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

// The compatibility verdict is part of runtime diagnostics; mirror the shared
// gate into the slot so DeviceStatus and the inspector observe it live.
subscribeSchemaCompat((compat) => {
  const state = slot();
  state.diagnostics.schemaCompat = compat;
  notifyDiagnostics(state);
});

/** Opens or reuses the one package runtime for the current browser document. */
export function getRuntime(): Promise<LofiRuntime> {
  if (recreationPromise) return recreationPromise;
  const state = slot();
  return adapter.get(
    () => getResource(state.client, () => createClient(state)),
    (db) => attachRuntime(state, db),
  );
}

/** Returns a value-only snapshot of runtime resource and durability counters. */
export function getRuntimeDiagnostics(): RuntimeDiagnostics {
  return { ...slot().diagnostics };
}

/** Applies one package-internal diagnostics update and notifies active observers. */
export function updateRuntimeDiagnostics(
  update: (diagnostics: RuntimeDiagnostics) => void,
): void {
  const state = slot();
  update(state.diagnostics);
  notifyDiagnostics(state);
}

/** The stable Jazz principal currently opened by the package runtime. */
export function getRuntimePrincipal(): string | null {
  return slot().principal;
}

/** Whether the active Jazz client was created with a managed transport to reconnect. */
export function runtimeCanReconnect(): boolean {
  return slot().serverConfigured;
}

/** Subscribes to diagnostics changes and returns an idempotent unsubscribe function. */
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

/** Replaces the active Jazz client while preserving the configured account secret. */
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

/**
 * Fully tears down a browser persistent worker and reloads the document. Jazz
 * alpha.53 cannot attach a second OPFS worker reliably in the same document
 * after shutdown; navigation is the supported clean-runtime boundary.
 */
export async function reloadBrowserRuntime(): Promise<never> {
  await shutdownRuntime();
  globalThis.location.reload();
  return await new Promise<never>(() => {});
}

async function releaseRuntime(state: RuntimeSlot): Promise<void> {
  await adapter.release((runtime) => runtime.shutdown());
  await shutdownResource(state.client, (db) => destroyClient(state, db));
}

/**
 * Replaces the local-first secret and every runtime object tied to the old
 * principal. Consumers and the old Jazz client close before the secret is
 * replaced; a fresh runtime then opens on the restored principal.
 * `onSecretSaved` runs once the new secret is durably saved and before the
 * replacement runtime opens, so callers can commit dependent state (namespace
 * election) only when replacement is past the point of failure.
 */
export function replaceRuntimePrincipal(
  secret: string,
  options: { onSecretSaved?: () => void } = {},
): Promise<LofiRuntime> {
  const state = slot();
  const previous = recreationPromise;
  const operation = (async () => {
    // Wait out any in-flight recreation instead of aliasing to it: an
    // unrelated recreation never saves this secret, so returning it would let
    // a restore report success without replacing the principal.
    await previous?.catch(() => undefined);
    const saveSecret = async () => {
      await BrowserAuthSecretStore.saveSecret(secret, { appId });
      options.onSecretSaved?.();
    };
    if (typeof window !== "undefined" && typeof SharedWorker !== "undefined") {
      await releaseRuntime(state);
      await saveSecret();
      globalThis.location.reload();
      return await new Promise<LofiRuntime>(() => {});
    }
    await adapter.release((runtime) => runtime.shutdown());
    const db = await replaceResource(
      state.client,
      saveSecret,
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

/** Releases stores, subscriptions, the Jazz client, and persistent worker resources. */
export function shutdownRuntime(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  const state = slot();
  const operation = (async () => {
    await recreationPromise?.catch(() => undefined);
    await releaseRuntime(state);
  })();
  const tracked = operation.finally(() => {
    if (shutdownPromise === tracked) shutdownPromise = null;
  });
  shutdownPromise = tracked;
  return tracked;
}

import.meta.hot?.dispose(() => adapter.dispose((runtime) => runtime.shutdown()));
