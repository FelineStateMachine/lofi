import { referenceApp } from "../app.ts";
import { serverUrl } from "./config.ts";
import { useDeviceCapabilities } from "./use-device-capabilities.ts";
import { settleUiMutation } from "./ui-mutation.ts";

export default function DeviceStatus() {
  const { report, requestPersistence } = useDeviceCapabilities();
  if (!report) return <p class="device-status">Checking durable-storage capabilities…</p>;

  const passkeyIdentity = referenceApp.identity === "device-passkey";
  const synced = Boolean(serverUrl);

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
          <dd>{passkeyIdentity ? "passkey account" : "device-local key"}</dd>
        </div>
        <div>
          <dt>Sync</dt>
          <dd>{synced ? "syncing to your account" : "local-only"}</dd>
        </div>
        <div>
          <dt>Account portability</dt>
          <dd>{passkeyIdentity ? "travels with your passkey" : "stays on this device"}</dd>
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
        {passkeyIdentity
          ? "The passkey is the account: it lives wherever the key lives and reaches every device that key can. There is no recovery service — lose every copy of the key and the account is gone."
          : 'Clearing site data destroys the device-local identity. This reference claims no recovery; set identity: "device-passkey" in src/app.ts for a portable, cross-device account.'}
      </p>
    </section>
  );
}
