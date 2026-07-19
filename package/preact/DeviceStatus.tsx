import type { VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
// Package-owned optional diagnostics UI.
import { useDeviceCapabilities } from "./use-device-capabilities.ts";
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
import { describeStoreStatus } from "../runtime/store-status.ts";
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

  useEffect(() => subscribePwaState(setPwa), []);
  useEffect(
    () => subscribeRuntimeDiagnostics(() => setRuntimeDiagnostics(getRuntimeDiagnostics())),
    [],
  );
  useEffect(() => {
    const refresh = () => setSession(readSession());
    refresh();
    // Re-read after electing to sync or restoring an account recreates the runtime.
    globalThis.addEventListener(runtimeRecreatedEvent, refresh);
    return () => globalThis.removeEventListener(runtimeRecreatedEvent, refresh);
  }, []);

  if (!report) return <p class="device-status">Checking device capabilities…</p>;

  const synced = Boolean(session?.syncAvailable);
  const sinkUnopenable = !session?.sink && readSinkRestoreOutcome() === "unopenable";
  const sinkState = session?.sink
    ? session.sink.source === "declared"
      ? `declared — ${session.sink.label ?? session.sink.host}`
      : "configured (build default)"
    : sinkUnopenable
    ? "declared — record unopenable on this device"
    : "not configured";
  const syncState = session?.syncing
    ? "syncing to your account"
    : session?.syncAvailable
    ? "available — not yet backed up"
    : "local-only";
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
        {!synced && (
          <p>
            Set <code>JAZZ_APP_ID</code> and <code>JAZZ_SERVER_URL</code> in <code>.env</code>{" "}
            and rebuild, or enroll a sync ticket at runtime, to replicate writes to your account.
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
          <Row label="WebAuthn" value={available(report.webAuthn)} />
          <Row label="PRF (at-rest key)" value={report.prf} />
        </dl>
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
