import { getLofiApp } from "./app.ts";

type PasskeyBackupErrorCode =
  | "not-supported"
  | "invalid-secret"
  | "create-failed"
  | "get-failed"
  | "no-credential"
  | "invalid-credential"
  | "verification-failed";

/** Stable categories for recoverable passkey backup and restore failures. */
export type RecoverablePasskeyErrorCode =
  | "cancelled"
  | "unsupported"
  | "credential-missing"
  | "rp-id-mismatch"
  | "verification-failed"
  | "invalid-credential"
  | "backup-failed"
  | "restore-failed";

const messages: Record<RecoverablePasskeyErrorCode, string> = {
  cancelled:
    "A passkey was not created or opened. Nothing on this device was replaced; try again or use the recovery phrase.",
  unsupported:
    "This browser cannot create or restore a recoverable passkey. Use the recovery phrase instead.",
  "credential-missing":
    "No recoverable passkey is available for this app and account. Check your passkey provider or use the recovery phrase.",
  "rp-id-mismatch":
    "This passkey belongs to a different app hostname. Open the canonical app address or use the recovery phrase.",
  "verification-failed":
    "The authenticator did not verify you. Unlock the passkey provider and try again, or use the recovery phrase.",
  "invalid-credential":
    "That credential is not a recoverable lofi account passkey. Choose the account-recovery passkey or use the recovery phrase.",
  "backup-failed":
    "The account could not be backed up to a passkey. The current account is unchanged; save the recovery phrase and try again.",
  "restore-failed":
    "The passkey could not restore this account. The current account is unchanged; use the recovery phrase or try again.",
};

/** A non-secret, actionable recoverable-passkey failure. */
export class RecoverablePasskeyError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "RecoverablePasskeyError";
  /** Creates a mapped passkey error with safe user-facing guidance. */
  constructor(readonly code: RecoverablePasskeyErrorCode, options?: ErrorOptions) {
    super(messages[code], options);
  }
}

export interface PasskeyBackupAdapter {
  backup(secret: string, displayName: string): Promise<void>;
  restore(): Promise<string>;
}

type VendorPasskeyError = Error & { code: PasskeyBackupErrorCode; cause?: unknown };

function isVendorPasskeyError(error: unknown): error is VendorPasskeyError {
  return error instanceof Error && error.name === "PasskeyBackupError" &&
    typeof (error as { code?: unknown }).code === "string";
}

function causeName(error: VendorPasskeyError): string {
  const cause = error.cause;
  return cause && typeof cause === "object" && "name" in cause ? String(cause.name) : "";
}

export function mapPasskeyBackupError(
  error: unknown,
  operation: "backup" | "restore",
): RecoverablePasskeyError {
  if (error instanceof RecoverablePasskeyError) return error;
  if (!isVendorPasskeyError(error)) {
    return new RecoverablePasskeyError(
      operation === "backup" ? "backup-failed" : "restore-failed",
    );
  }
  const vendorCode: PasskeyBackupErrorCode = error.code;
  const domName = causeName(error);
  if (vendorCode === "not-supported") return new RecoverablePasskeyError("unsupported");
  if (vendorCode === "no-credential") return new RecoverablePasskeyError("credential-missing");
  if (vendorCode === "verification-failed") {
    return new RecoverablePasskeyError("verification-failed");
  }
  if (vendorCode === "invalid-credential" || vendorCode === "invalid-secret") {
    return new RecoverablePasskeyError("invalid-credential");
  }
  if (domName === "SecurityError") return new RecoverablePasskeyError("rp-id-mismatch");
  if (domName === "NotAllowedError" || domName === "AbortError") {
    return new RecoverablePasskeyError("cancelled");
  }
  return new RecoverablePasskeyError(
    operation === "backup" ? "backup-failed" : "restore-failed",
  );
}

export function configuredPasskeyRpId(): string {
  const configured = getLofiApp().passkey?.rpId?.trim();
  if (configured) return configured;
  return globalThis.location?.hostname ?? "localhost";
}

export function createPasskeyBackupAdapter(): PasskeyBackupAdapter {
  const app = getLofiApp();
  let implementation: Promise<PasskeyBackupAdapter> | undefined;
  const resolve = () =>
    implementation ??= import("jazz-tools/passkey-backup").then(({ BrowserPasskeyBackup }) =>
      new BrowserPasskeyBackup({
        appName: app.name,
        appHostname: configuredPasskeyRpId(),
      })
    );
  return {
    async backup(secret, displayName) {
      await (await resolve()).backup(secret, displayName);
    },
    async restore() {
      return await (await resolve()).restore();
    },
  };
}

/** Runs the vendor backup boundary with lofi's stable error contract. */
export async function backupSecretWithPasskey(
  adapter: PasskeyBackupAdapter,
  secret: string,
  displayName: string,
): Promise<void> {
  try {
    await adapter.backup(secret, displayName);
  } catch (error) {
    throw mapPasskeyBackupError(error, "backup");
  }
}

/** Runs the vendor restore boundary with lofi's stable error contract. */
export async function restoreSecretWithPasskey(
  adapter: PasskeyBackupAdapter,
): Promise<string> {
  try {
    return await adapter.restore();
  } catch (error) {
    throw mapPasskeyBackupError(error, "restore");
  }
}
