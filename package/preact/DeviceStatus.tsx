import type { VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
// Package-owned optional diagnostics UI.
import { useDeviceCapabilities } from "./use-device-capabilities.ts";
import { type CredentialOriginReport, getAuthCapability } from "../runtime/auth.ts";
import { settleUiMutation } from "../runtime/ui-mutation.ts";
import { getPwaState, type PwaState, subscribePwaState } from "../runtime/pwa.ts";
import { PwaActions } from "./PwaActions.tsx";
import {
  getRuntimeDiagnostics,
  runtimeRecreatedEvent,
  subscribeRuntimeDiagnostics,
} from "../runtime/runtime.ts";
import { describeSchemaCompat } from "../runtime/schema-compat.ts";
import { describeStorageFork, dismissStorageFork } from "../runtime/storage-fork.ts";
import { useStorageFork } from "./use-storage-fork.ts";
import { readSession, type Session } from "../runtime/session.ts";
import { readSinkRestoreOutcome } from "../runtime/data-sink.ts";
import { describeStoreStatus, type RuntimeStoreStatus } from "../runtime/store-status.ts";
import { RuntimeRecovery } from "./RuntimeRecovery.tsx";

// One label/value row inside a category's definition list.
function Row({ label, value }: { label: string; value: string }): VNode {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const available = (present: boolean) => (present ? "available" : "missing");

/** One-line credential-origin verdict that distinguishes API support from deployability. */
export function describeCredentialOrigin(origin: CredentialOriginReport): string {
  switch (origin.status) {
    case "stable":
      return `stable — ${origin.rpId}`;
    case "local-only":
      return `local development only — ${origin.rpId}`;
    case "unverified":
      return `unverified — ${origin.rpId}`;
    case "blocked":
      return origin.rpId ? `blocked — ${origin.rpId}` : "blocked";
  }
}

/**
 * The one-line Data sync verdict. The blocked dispositions are first-class —
 * the report must say *why* nothing is syncing, not merely that it is not:
 * the election belongs to another account, the store refused (no schema, or
 * the ticket is no longer accepted), the declared sink's sealed record cannot
 * be opened on this device, or no sync location exists at all. Exported for
 * tests; the entry does not re-export it.
 */
export function describeSyncState(input: {
  syncing: boolean;
  syncAvailable: boolean;
  ownerMismatch: boolean;
  storeState: RuntimeStoreStatus["state"];
  sinkUnopenable: boolean;
}): string {
  if (input.ownerMismatch) return "paused — sync belongs to another account on this device";
  if (input.storeState === "no_schema") return "blocked — store has no schema for this app";
  if (input.storeState === "ticket_rejected") return "blocked — ticket no longer accepted";
  if (input.sinkUnopenable) return "blocked — sync location record unopenable";
  if (input.syncing) return "syncing to your account";
  if (input.syncAvailable) return "available — not yet backed up";
  return "local-only";
}

/**
 * Renders the Device gate: every subsystem's live status — storage, sync,
 * auth, and PWA — grouped by the module that owns it, so the panel doubles
 * as a map of where to hook in. Optional: it is built entirely on public
 * runtime APIs (device capabilities, PWA state, runtime diagnostics, the
 * session), so an application can replace it with its own status UI over the
 * same sources.
 *
 * @example
 * ```tsx
 * import { DeviceStatus } from "@nzip/lofi/preact";
 *
 * export function SettingsPage() {
 *   return <DeviceStatus />;
 * }
 * ```
 *
 * @returns The device diagnostics panel, grouped by owning subsystem.
 */
export function DeviceStatus(): VNode {
  const { report, requestPersistence } = useDeviceCapabilities();
  const fork = useStorageFork();
  const [pwa, setPwa] = useState<PwaState>(getPwaState());
  const [session, setSession] = useState<Session | null>(null);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState(getRuntimeDiagnostics());
  const [credentialOrigin, setCredentialOrigin] = useState<CredentialOriginReport | null>(null);

  useEffect(() => subscribePwaState(setPwa), []);
  useEffect(
    () =>
      subscribeRuntimeDiagnostics(() => {
        setRuntimeDiagnostics(getRuntimeDiagnostics());
        // Initial boot restores a sealed runtime-declared sink asynchronously.
        // An island can mount before that restore completes, so refresh the
        // synchronous session snapshot whenever boot diagnostics advance.
        setSession(readSession());
      }),
    [],
  );
  useEffect(() => {
    const refresh = () => setSession(readSession());
    refresh();
    // Re-read after electing to sync or restoring an account recreates the runtime.
    globalThis.addEventListener(runtimeRecreatedEvent, refresh);
    return () => globalThis.removeEventListener(runtimeRecreatedEvent, refresh);
  }, []);
  useEffect(() => {
    let active = true;
    void getAuthCapability().then((capability) => {
      if (active) setCredentialOrigin(capability.origin);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!report) return <p class="device-status">Checking device capabilities…</p>;

  const synced = Boolean(session?.syncAvailable);
  const ownerMismatch = Boolean(session?.syncOwnerMismatch);
  const syncOwner = runtimeDiagnostics.syncOwner;
  const sinkUnopenable = !session?.sink && readSinkRestoreOutcome() === "unopenable";
  const sinkState = session?.sink
    ? session.sink.source === "declared"
      ? `declared — ${session.sink.label ?? session.sink.host}`
      : "configured (build default)"
    : sinkUnopenable
    ? "declared — record unopenable on this device"
    : "not configured";
  const syncState = describeSyncState({
    syncing: Boolean(session?.syncing),
    syncAvailable: synced,
    ownerMismatch,
    storeState: runtimeDiagnostics.storeStatus.state,
    sinkUnopenable,
  });
  const backupState = session?.backedUp
    ? "recovery phrase"
    : session?.syncAvailable
    ? "not backed up"
    : "local-only";

  return (
    <section class="device-status" aria-labelledby="device-status-title">
      <header>
        <p class="eyebrow">Device gate</p>
        <h2 id="device-status-title">Deployment status &amp; integration points</h2>
      </header>

      <div class="device-category">
        <h3>Shared worker &amp; durable storage</h3>
        <p class="device-hook">
          Hook in: <code>@nzip/lofi</code> device capabilities and runtime
        </p>
        <dl>
          <Row
            label="Durable driver"
            value={report.durableDriverSupported ? "supported" : "blocked"}
          />
          <Row label="Secure context" value={report.secureContext ? "secure" : "not secure"} />
          <Row label="OPFS" value={available(report.opfs)} />
          <Row label="SharedWorker" value={available(report.sharedWorker)} />
          <Row label="Web Locks" value={available(report.webLocks)} />
          <Row label="MessageChannel" value={available(report.messageChannel)} />
          <Row label="Storage persistence" value={report.persistentPermission} />
          <Row
            label="Runtime startup"
            value={runtimeDiagnostics.startupFailure?.code ??
              (runtimeDiagnostics.storageState === "persistent-driver-open" ? "ready" : "opening")}
          />
        </dl>
        <RuntimeRecovery failure={runtimeDiagnostics.startupFailure} />
        <button type="button" onClick={() => void settleUiMutation(requestPersistence())}>
          Request storage persistence
        </button>
        <p>
          OPFS capability and eviction protection are separate. A declined persistence request does
          not mean the Jazz driver is using memory.
        </p>
      </div>

      <div class="device-category">
        <h3>Data sync</h3>
        <p class="device-hook">
          Hook in: <code>@nzip/lofi</code> session and runtime
        </p>
        <dl>
          <Row label="Sync" value={syncState} />
          <Row label="Sync location" value={sinkState} />
          <Row label="Store" value={describeStoreStatus(runtimeDiagnostics.storeStatus)} />
        </dl>
        {ownerMismatch && (
          <p>
            Sync on this device was set up by{" "}
            {syncOwner.state === "mismatch" && syncOwner.owner_user_id
              ? (
                <>
                  the account <code>{syncOwner.owner_user_id}</code>
                </>
              )
              : "a different account"}. Nothing connects while the accounts differ, so neither store
            can merge into the other. Stop syncing in the account panel to release this device for
            the current account, or restore the owning account to resume.
          </p>
        )}
        {runtimeDiagnostics.storeStatus.state === "no_schema" && (
          <p>{runtimeDiagnostics.storeStatus.message}</p>
        )}
        {runtimeDiagnostics.storeStatus.state === "ticket_rejected" && (
          <p>
            The node no longer accepts this device's credential — the ticket was revoked, the node
            was reset, or this device's key is gone. Clear the sync location and enroll a fresh
            ticket; local data is intact and pushes up on re-enrollment.
          </p>
        )}
        {sinkUnopenable && (
          <p>
            A sync location is declared on this device, but its sealed record cannot be opened — the
            device key that sealed it is gone, usually a cleared browser store. The device runs
            local-only until re-enrollment. Clear the sync location and enroll a fresh ticket; local
            data is intact and pushes up.
          </p>
        )}
        {!synced && !ownerMismatch && (
          <p>
            Enroll an app-connect ticket from your node to replicate writes to your account — a
            saved ticket autofills from your password manager. Building with{" "}
            <code>JAZZ_APP_ID</code> and <code>JAZZ_SERVER_URL</code> in <code>.env</code>{" "}
            remains the compiled-in alternative.
          </p>
        )}
      </div>

      <div class="device-category">
        <h3>Auth</h3>
        <p class="device-hook">
          Hook in: <code>@nzip/lofi</code> auth and session
        </p>
        <dl>
          <Row label="Identity" value="local-first account" />
          <Row label="Backup" value={backupState} />
          <Row label="WebAuthn API" value={available(report.webAuthn)} />
          <Row label="PRF API (at-rest key)" value={report.prf} />
          <Row
            label="Credential origin"
            value={credentialOrigin ? describeCredentialOrigin(credentialOrigin) : "checking"}
          />
        </dl>
        {credentialOrigin && credentialOrigin.status !== "stable" && (
          <p>{credentialOrigin.action}</p>
        )}
      </div>

      <div class="device-category">
        <h3>PWA</h3>
        <p class="device-hook">
          Hook in: <code>@nzip/lofi</code> PWA state
        </p>
        <dl>
          <Row label="Display mode" value={report.displayMode} />
          <Row label="Install" value={pwa.install} />
          <Row label="Service worker" value={pwa.worker} />
          <Row label="Update" value={pwa.update} />
          <Row
            label="Schema compatibility"
            value={describeSchemaCompat(runtimeDiagnostics.schemaCompat)}
          />
          <Row label="Storage container" value={describeStorageFork(fork)} />
        </dl>
        {(runtimeDiagnostics.schemaCompat.state === "data-ahead" ||
          runtimeDiagnostics.schemaCompat.state === "updating") && (
          <p>{runtimeDiagnostics.schemaCompat.message}</p>
        )}
        {fork.state === "fork-detected" && (
          <>
            <p>{fork.message}</p>
            <button type="button" onClick={() => dismissStorageFork()}>
              Dismiss
            </button>
          </>
        )}
        <PwaActions title="Install & updates" />
      </div>
    </section>
  );
}
