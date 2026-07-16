import { useEffect, useState } from "preact/hooks";
import { applyPwaUpdate, getPwaState, requestPwaInstall, subscribePwaState } from "./pwa.ts";
import { useDeviceCapabilities } from "./use-device-capabilities.ts";
import { settleUiMutation } from "./ui-mutation.ts";

export default function DeviceStatus() {
  const { report, requestPersistence } = useDeviceCapabilities();
  const [pwa, setPwa] = useState(getPwaState);
  useEffect(() => subscribePwaState(setPwa), []);
  if (!report) return <p class="device-status">Checking durable-storage capabilities…</p>;

  return (
    <section class="device-status" aria-labelledby="device-status-title">
      <header>
        <p class="eyebrow">Device gate</p>
        <h2 id="device-status-title">
          {report.durableDriverSupported ? "Durable driver supported" : "Durable driver blocked"}
        </h2>
      </header>
      <dl>
        <div>
          <dt>Context</dt>
          <dd>{report.secureContext ? "secure" : "not secure"}</dd>
        </div>
        <div>
          <dt>OPFS</dt>
          <dd>{report.opfs ? "available" : "missing"}</dd>
        </div>
        <div>
          <dt>SharedWorker</dt>
          <dd>{report.sharedWorker ? "available" : "missing"}</dd>
        </div>
        <div>
          <dt>Web Locks</dt>
          <dd>{report.webLocks ? "available" : "missing"}</dd>
        </div>
        <div>
          <dt>Storage persistence</dt>
          <dd>{report.persistentPermission}</dd>
        </div>
        <div>
          <dt>Display mode</dt>
          <dd>{report.displayMode}</dd>
        </div>
        <div>
          <dt>PWA worker</dt>
          <dd>{pwa.worker}</dd>
        </div>
        <div>
          <dt>Install</dt>
          <dd>{pwa.install}</dd>
        </div>
        <div>
          <dt>Identity</dt>
          <dd>device-local key</dd>
        </div>
        <div>
          <dt>Passkey backup</dt>
          <dd>blocked by alpha security review</dd>
        </div>
      </dl>
      <button type="button" onClick={() => void settleUiMutation(requestPersistence())}>
        Request storage persistence
      </button>
      {pwa.install === "available" && (
        <button
          type="button"
          onClick={() => void requestPwaInstall()}
        >
          Install this app
        </button>
      )}
      {pwa.worker === "update-available" && (
        <button type="button" onClick={applyPwaUpdate}>Apply app update</button>
      )}
      {pwa.install === "manual-ios" && (
        <p>
          On iPhone or iPad, use Share → Add to Home Screen when that action is available. If
          regional browser rules hide installation, continue in the browser; retained data has less
          eviction protection.
        </p>
      )}
      {pwa.install === "unavailable" && (
        <p>
          This browser has not offered an install action. The app remains usable in browser mode.
        </p>
      )}
      {pwa.failure && (
        <p role="alert">
          PWA {pwa.failure.code} failure:{" "}
          {pwa.failure.message}. Reload once online; if it repeats, clear this site's application
          cache and rebuild.
        </p>
      )}
      <p>
        OPFS capability and eviction protection are separate. A declined persistence request does
        not mean the Jazz driver is using memory.
      </p>
      <p>
        Clearing site data destroys the device-local identity unless a separate recovery mechanism
        has been verified. This reference does not claim passkey recovery.
      </p>
    </section>
  );
}
