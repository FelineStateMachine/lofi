import { referenceApp } from "../app.ts";

export type DeviceCapabilityReport = {
  secureContext: boolean;
  serviceWorker: boolean;
  opfs: boolean;
  sharedWorker: boolean;
  webLocks: boolean;
  messageChannel: boolean;
  durableDriverSupported: boolean;
  credentialOrigin: CredentialOriginReport;
  webAuthn: boolean;
  prf: "available" | "not-reported" | "unknown" | "unavailable";
  persistentPermission: "granted" | "not-granted" | "unavailable" | "error";
  displayMode: "standalone" | "browser";
};

export type CredentialOriginReport = {
  status: "stable" | "local-only" | "unverified" | "blocked";
  rpId: string;
  action: string;
};

type StorageManagerWithOpfs = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

function browserStorage(): StorageManagerWithOpfs | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : navigator.storage as StorageManagerWithOpfs | undefined;
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1";
}

function matchesCredentialOrigin(hostname: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase();
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(1);
    return hostname.length > suffix.length && hostname.endsWith(suffix);
  }
  return normalized.length > 0 && !normalized.includes("*") && hostname === normalized;
}

export function classifyCredentialOrigin(
  url: URL,
  trustedOrigins: readonly string[] = referenceApp.credentialOrigins,
): CredentialOriginReport {
  const rpId = url.hostname;
  if (isLocalHostname(rpId)) {
    return {
      status: "local-only",
      rpId,
      action: "use `deno task --tunnel dev` before enrolling a device credential",
    };
  }
  if (url.protocol !== "https:" || !rpId || isIpAddress(rpId)) {
    return {
      status: "blocked",
      rpId,
      action:
        "use the stable HTTPS URL printed by `deno task --tunnel dev` before enrolling a device credential",
    };
  }
  if (trustedOrigins.some((pattern) => matchesCredentialOrigin(rpId, pattern))) {
    return {
      status: "stable",
      rpId,
      action: "keep this hostname for the lifetime of any device credential",
    };
  }
  return {
    status: "unverified",
    rpId,
    action: "confirm this custom hostname is permanent before enrolling a device credential",
  };
}

function currentCredentialOrigin(): CredentialOriginReport {
  if (typeof location === "undefined") {
    return { status: "blocked", rpId: "", action: "open the application in a browser" };
  }
  return classifyCredentialOrigin(new URL(location.href));
}

type PublicKeyCredentialCapabilities = typeof PublicKeyCredential & {
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
};

async function readPrfCapability(
  webAuthn: boolean,
): Promise<DeviceCapabilityReport["prf"]> {
  if (!webAuthn) return "unavailable";
  const publicKeyCredential = PublicKeyCredential as PublicKeyCredentialCapabilities;
  if (typeof publicKeyCredential.getClientCapabilities !== "function") return "unknown";
  try {
    const capabilities = await publicKeyCredential.getClientCapabilities();
    return capabilities["extension:prf"] === true ? "available" : "not-reported";
  } catch {
    return "unknown";
  }
}

export function durableCapabilityReport(): Omit<
  DeviceCapabilityReport,
  "persistentPermission"
> {
  const storage = browserStorage();
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  const secureContext = globalThis.isSecureContext === true;
  const serviceWorker = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const opfs = typeof storage?.getDirectory === "function";
  const sharedWorker = typeof globalThis.SharedWorker === "function";
  const webLocks = typeof locks?.request === "function";
  const messageChannel = typeof globalThis.MessageChannel === "function";
  return {
    secureContext,
    serviceWorker,
    opfs,
    sharedWorker,
    webLocks,
    messageChannel,
    durableDriverSupported: secureContext && opfs && sharedWorker && webLocks && messageChannel,
    credentialOrigin: currentCredentialOrigin(),
    webAuthn: typeof PublicKeyCredential === "function",
    prf: "unknown",
    displayMode: typeof globalThis.matchMedia === "function" &&
        globalThis.matchMedia("(display-mode: standalone)").matches
      ? "standalone"
      : "browser",
  };
}

export async function readDeviceCapabilityReport(): Promise<DeviceCapabilityReport> {
  const base = durableCapabilityReport();
  const storage = browserStorage();
  const prf = await readPrfCapability(base.webAuthn);
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

export class CredentialOriginUnsupportedError extends Error {
  override name = "CredentialOriginUnsupportedError";
  readonly report: CredentialOriginReport;

  constructor(report = currentCredentialOrigin()) {
    super(
      `Device credential enrollment is blocked for RP ID ${
        report.rpId || "(missing)"
      }; ${report.action}.`,
    );
    this.report = report;
  }
}

export function assertStableCredentialOrigin(): string {
  const report = currentCredentialOrigin();
  if (report.status !== "stable") throw new CredentialOriginUnsupportedError(report);
  return report.rpId;
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
