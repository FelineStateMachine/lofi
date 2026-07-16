import { useEffect, useState } from "preact/hooks";
import {
  createTestPasskey,
  hasStoredTestPasskey,
  PasskeyCheckError,
  retrieveTestPasskey,
  verifySiblingRpRejected,
} from "./passkey-check.ts";
import { applyPwaUpdate, getPwaState, requestPwaInstall, subscribePwaState } from "./pwa.ts";
import { useDeviceCapabilities } from "./use-device-capabilities.ts";
import { settleUiMutation } from "./ui-mutation.ts";

export default function DeviceStatus() {
  const { report, requestPersistence } = useDeviceCapabilities();
  const [pwa, setPwa] = useState(getPwaState);
  const [passkey, setPasskey] = useState("checking");
  const [hasPasskey, setHasPasskey] = useState(false);
  const [siblingRp, setSiblingRp] = useState("not-checked");
  useEffect(() => subscribePwaState(setPwa), []);
  useEffect(() => {
    const stored = hasStoredTestPasskey();
    setHasPasskey(stored);
    setPasskey(stored ? "created" : "not-created");
  }, []);
  if (!report) return <p class="device-status">Checking durable-storage capabilities…</p>;

  const runPasskeyCheck = async (
    pending: string,
    action: () => Promise<{ status: string }>,
    update: (status: string) => void = setPasskey,
    onSuccess?: () => void,
  ) => {
    update(pending);
    try {
      update((await action()).status);
      onSuccess?.();
    } catch (error) {
      update(error instanceof PasskeyCheckError ? error.code : "unknown");
    }
  };

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
          <dt>Service worker</dt>
          <dd>{report.serviceWorker ? "available" : "missing"}</dd>
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
          <dt>Credential origin</dt>
          <dd>{report.credentialOrigin.status}</dd>
        </div>
        <div>
          <dt>Future RP ID</dt>
          <dd>{report.credentialOrigin.rpId || "unavailable"}</dd>
        </div>
        <div>
          <dt>WebAuthn</dt>
          <dd>{report.webAuthn ? "available" : "missing"}</dd>
        </div>
        <div>
          <dt>PRF client extension</dt>
          <dd>{report.prf}</dd>
        </div>
        <div>
          <dt>Passkey backup</dt>
          <dd>blocked by alpha security review</dd>
        </div>
        <div>
          <dt>Test passkey</dt>
          <dd>{passkey}</dd>
        </div>
        <div>
          <dt>Sibling RP guard</dt>
          <dd>{siblingRp}</dd>
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
      {report.webAuthn && report.credentialOrigin.status === "stable" &&
        !hasPasskey && (
        <button
          type="button"
          onClick={() =>
            void runPasskeyCheck(
              "creating",
              createTestPasskey,
              setPasskey,
              () => setHasPasskey(true),
            )}
        >
          Create test passkey
        </button>
      )}
      {report.webAuthn && report.credentialOrigin.status === "stable" &&
        hasPasskey && (
        <button
          type="button"
          onClick={() => void runPasskeyCheck("retrieving", retrieveTestPasskey)}
        >
          Retrieve test passkey
        </button>
      )}
      {report.webAuthn && report.credentialOrigin.status === "stable" && (
        <button
          type="button"
          onClick={() => void runPasskeyCheck("checking", verifySiblingRpRejected, setSiblingRp)}
        >
          Verify sibling RP rejection
        </button>
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
      {report.credentialOrigin.status !== "stable" && (
        <p role="alert">Credential origin: {report.credentialOrigin.action}.</p>
      )}
      <p>
        Clearing site data destroys the device-local identity unless a separate recovery mechanism
        has been verified. This reference does not claim passkey recovery.
      </p>
      <p>
        The test passkey proves this origin can create and retrieve a browser credential. It is not
        used for application identity, backup, or recovery; only its opaque credential ID is kept in
        this origin's local storage for retrieval.
      </p>
    </section>
  );
}
