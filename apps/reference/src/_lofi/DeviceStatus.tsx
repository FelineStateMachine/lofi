import { useDeviceCapabilities } from "./use-device-capabilities.ts";
import { settleUiMutation } from "./ui-mutation.ts";

export default function DeviceStatus() {
  const { report, requestPersistence } = useDeviceCapabilities();
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
