import type { JSX, VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
// Package-owned optional diagnostics UI.
import { serverUrl } from "../runtime/config.ts";
import { useDeviceCapabilities } from "./use-device-capabilities.ts";
import { settleUiMutation } from "../runtime/ui-mutation.ts";
import { getPwaState, type PwaState, subscribePwaState } from "../runtime/pwa.ts";
import { PwaActions } from "./PwaActions.tsx";
import {
  getRuntimeDiagnostics,
  runtimeRecreatedEvent,
  subscribeRuntimeDiagnostics,
} from "../runtime/runtime.ts";
import { readSession, type Session } from "../runtime/session.ts";
import { RuntimeRecovery } from "./RuntimeRecovery.tsx";

/**
 * The Device gate: every subsystem's live status, grouped by the system it
 * belongs to. It doubles as a map of where to hook in — each category names the
 * module that owns it, so a reading of the deployment is also a reading of the
 * framework's seams.
 */

// One label/value row inside a category's definition list.
function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const available = (present: boolean) => (present ? "available" : "missing");

/**
 * Renders live storage, sync, auth, and PWA capability diagnostics.
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
export default function DeviceStatus(): VNode {
  const { report, requestPersistence } = useDeviceCapabilities();
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

  const synced = Boolean(serverUrl);
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
          <Row label="Managed server" value={synced ? "configured" : "not configured"} />
        </dl>
        {!synced && (
          <p>
            Set <code>JAZZ_APP_ID</code> and <code>JAZZ_SERVER_URL</code> in{" "}
            <code>.env</code>, then rebuild, to replicate writes to your account.
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
        </dl>
        <PwaActions title="Install & updates" />
      </div>
    </section>
  );
}
