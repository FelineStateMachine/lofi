export type DeviceCapabilityReport = {
  secureContext: boolean;
  opfs: boolean;
  sharedWorker: boolean;
  webLocks: boolean;
  messageChannel: boolean;
  durableDriverSupported: boolean;
  persistentPermission: "granted" | "not-granted" | "unavailable" | "error";
  displayMode: "standalone" | "browser";
};

type StorageManagerWithOpfs = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

function browserStorage(): StorageManagerWithOpfs | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : navigator.storage as StorageManagerWithOpfs | undefined;
}

export function durableCapabilityReport(): Omit<
  DeviceCapabilityReport,
  "persistentPermission"
> {
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
    displayMode: typeof globalThis.matchMedia === "function" &&
        globalThis.matchMedia("(display-mode: standalone)").matches
      ? "standalone"
      : "browser",
  };
}

export async function readDeviceCapabilityReport(): Promise<DeviceCapabilityReport> {
  const base = durableCapabilityReport();
  const storage = browserStorage();
  if (typeof storage?.persisted !== "function") {
    return { ...base, persistentPermission: "unavailable" };
  }
  try {
    return {
      ...base,
      persistentPermission: await storage.persisted() ? "granted" : "not-granted",
    };
  } catch {
    return { ...base, persistentPermission: "error" };
  }
}

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

export class DurableStorageUnsupportedError extends Error {
  override name = "DurableStorageUnsupportedError";
  readonly report: ReturnType<typeof durableCapabilityReport>;

  constructor(report = durableCapabilityReport()) {
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

export function assertDurableBrowser(): void {
  const report = durableCapabilityReport();
  if (!report.durableDriverSupported) throw new DurableStorageUnsupportedError(report);
}
