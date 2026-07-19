import { type PrfSupport, readPrfSupport } from "./auth.ts";

/** Browser capabilities that determine whether lofi can provide its runtime guarantees. */
export type DeviceCapabilityReport = {
  // Package-owned device capability checks.
  secureContext: boolean;
  opfs: boolean;
  sharedWorker: boolean;
  webLocks: boolean;
  messageChannel: boolean;
  durableDriverSupported: boolean;
  webAuthn: boolean;
  prf: PrfSupport;
  persistentPermission: "granted" | "not-granted" | "unavailable" | "error";
  displayMode: "standalone" | "browser";
};

/** Capability report that excludes the separately requested persistence permission. */
export type DurableCapabilityReport = Omit<DeviceCapabilityReport, "persistentPermission">;

type StorageManagerWithOpfs = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

function browserStorage(): StorageManagerWithOpfs | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : navigator.storage as StorageManagerWithOpfs | undefined;
}

/** Reads synchronous browser capabilities needed by the durable Jazz driver. */
export function durableCapabilityReport(): DurableCapabilityReport {
  const storage = browserStorage();
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  const secureContext = globalThis.isSecureContext === true;
  const opfs = typeof storage?.getDirectory === "function";
  const sharedWorker = typeof globalThis.SharedWorker === "function";
  const webLocks = typeof locks?.request === "function";
  const messageChannel = typeof globalThis.MessageChannel === "function";
  return {
    secureContext,
    opfs,
    sharedWorker,
    webLocks,
    messageChannel,
    durableDriverSupported: secureContext && opfs && sharedWorker && webLocks && messageChannel,
    webAuthn: typeof PublicKeyCredential === "function",
    prf: "unknown",
    displayMode: typeof globalThis.matchMedia === "function" &&
        globalThis.matchMedia("(display-mode: standalone)").matches
      ? "standalone"
      : "browser",
  };
}

/** Reads the complete capability report without requesting new browser permission. */
export async function readDeviceCapabilityReport(): Promise<DeviceCapabilityReport> {
  const base = durableCapabilityReport();
  const storage = browserStorage();
  const prf = await readPrfSupport(base.webAuthn);
  if (typeof storage?.persisted !== "function") {
    return { ...base, prf, persistentPermission: "unavailable" };
  }
  try {
    return {
      ...base,
      prf,
      persistentPermission: await storage.persisted() ? "granted" : "not-granted",
    };
  } catch {
    return { ...base, prf, persistentPermission: "error" };
  }
}

/** Requests eviction protection, then returns the browser's authoritative capability report. */
export async function requestPersistentStorage(): Promise<DeviceCapabilityReport> {
  const storage = browserStorage();
  if (typeof storage?.persist !== "function") return await readDeviceCapabilityReport();
  try {
    await storage.persist();
  } catch {
    // The subsequent read reports the browser's authoritative persisted state.
  }
  return await readDeviceCapabilityReport();
}

/** Raised when the browser cannot provide the durable local-storage contract. */
export class DurableStorageUnsupportedError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override name = "DurableStorageUnsupportedError";
  /** Capabilities observed when the runtime rejected startup. */
  readonly report: DurableCapabilityReport;

  /** Creates an error that identifies every missing durable-driver capability. */
  constructor(report: DurableCapabilityReport = durableCapabilityReport()) {
    const missing = Object.entries({
      secureContext: report.secureContext,
      opfs: report.opfs,
      sharedWorker: report.sharedWorker,
      webLocks: report.webLocks,
      messageChannel: report.messageChannel,
    }).filter(([, available]) => !available).map(([name]) => name);
    super(
      `Durable local storage is unsupported; missing ${
        missing.join(", ")
      }. Use the stable HTTPS device URL in a supported browser.`,
    );
    this.report = report;
  }
}

/** True when an error is a browser unable to provide the durable-storage contract. */
export function isDurableStorageUnsupportedError(
  error: unknown,
): error is DurableStorageUnsupportedError {
  return error instanceof DurableStorageUnsupportedError;
}

/** Throws unless the current browser can open lofi's persistent local driver. */
export function assertDurableBrowser(): void {
  const report = durableCapabilityReport();
  if (!report.durableDriverSupported) throw new DurableStorageUnsupportedError(report);
}
