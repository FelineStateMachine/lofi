/**
 * Package-owned account session runtime.
 * Account session for lofi's local-first identity: the glue between the account
 * secret the runtime opens and the user's choice to back it up and sync.
 *
 * First boot is **local-only** — a random per-device account opens immediately,
 * with no ceremony and no network. From there the user can *elect* to back up
 * and sync: revealing a recovery phrase (the portable, honest backup of the
 * exact same account) and turning on replication to the managed Jazz app. The
 * account identity never changes, so electing to sync preserves every write made
 * while local-only. Restoring a phrase on a new device reconstructs the same
 * account and its synced data flows back down.
 *
 * The small, honest UI that drives this lives in author space
 * (`src/islands/AccountGate.tsx`) — this module is the framework side.
 *
 * @module
 */

import { BrowserAuthSecretStore } from "jazz-tools";
import { getLofiApp } from "./app.ts";
import { appId, setSyncElected, syncAvailable, syncElected, syncing } from "./config.ts";
import { fromRecoveryPhrase, RecoveryError, toRecoveryPhrase } from "./recovery.ts";
import { authenticateDeviceCredential, AuthError, enrollDeviceCredential } from "./auth.ts";
import {
  backupSecretWithPasskey,
  createPasskeyBackupAdapter,
  RecoverablePasskeyError,
  restoreSecretWithPasskey,
} from "./passkey-recovery.ts";
import {
  getRuntime,
  getRuntimePrincipal,
  recreateRuntime,
  reloadBrowserRuntime,
  replaceRuntimePrincipal,
  runtimeCanReconnect,
  runtimeRecreatedEvent,
} from "./runtime.ts";

/** A snapshot of the account: what is possible and what the user has chosen. */
export type Session = {
  /** Stable, app-scoped Jazz sharing identity for the active account. */
  user_id: string | null;
  /** Whether a managed Jazz app is configured, so backup + sync is possible at all. */
  syncAvailable: boolean;
  /** Whether the user has elected to back up and sync this account on this device. */
  backedUp: boolean;
  /** Whether writes replicate right now (available *and* elected). */
  syncing: boolean;
  /**
   * Whether a passkey guards the recovery phrase on this device — revealing it
   * then requires a user-verifying ceremony. This confirms the person is present;
   * it does **not** encrypt the account secret held on the device.
   */
  phraseGuarded: boolean;
  /** Whether this device created a passkey containing a recoverable account backup. */
  passkeyRecoverable: boolean;
};

// A per-device flag recording that the user enrolled a passkey to guard the
// recovery phrase. The passkey itself is a resident credential on the device;
// this only remembers to ask for it before revealing the phrase.
const phraseGuardKey = `lofi:phrase-passkey:${appId}`;
const recoverablePasskeyKey = `lofi:recoverable-passkey:${appId}`;
const managedRuntimeKey = `lofi:managed-runtime:${appId}`;
const migrateLocalRowsKey = `lofi:migrate-local-rows:${appId}`;

function phraseGuarded(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(phraseGuardKey) === "1";
  } catch {
    return false;
  }
}

function setPhraseGuarded(guarded: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (guarded) localStorage.setItem(phraseGuardKey, "1");
    else localStorage.removeItem(phraseGuardKey);
  } catch {
    // A private-mode storage failure must not break the ceremony itself.
  }
}

function passkeyRecoverable(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(recoverablePasskeyKey) === "1";
  } catch {
    return false;
  }
}

function setPasskeyRecoverable(value: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (value) localStorage.setItem(recoverablePasskeyKey, "1");
    else localStorage.removeItem(recoverablePasskeyKey);
  } catch {
    // The credential remains the source of truth if local metadata cannot persist.
  }
}

/** Reads the current session. Synchronous — it never prompts or touches the network. */
export function readSession(): Session {
  return {
    user_id: getRuntimePrincipal(),
    syncAvailable,
    backedUp: syncElected(),
    syncing: syncing(),
    phraseGuarded: phraseGuarded(),
    passkeyRecoverable: passkeyRecoverable(),
  };
}

/** Resolves the runtime before returning a session with a stable `user_id`. */
export async function readAccountSession(): Promise<Session> {
  await getRuntime();
  return readSession();
}

// The account secret the runtime is already using. `getOrCreateSecret` is a
// read-through: the runtime created it on first boot, so this returns that same
// secret rather than minting a new one.
async function currentSecret(): Promise<string> {
  return await BrowserAuthSecretStore.getOrCreateSecret({ appId });
}

/**
 * Enrolls a passkey to guard the recovery phrase on this device. Enrollment is a
 * user-verifying ceremony, so it doubles as the confirmation for the reveal that
 * immediately follows. Returns `true` when a guard was set; `false` (without
 * throwing) when this browser or origin cannot enroll a passkey, so the caller
 * can still show the phrase while telling the user it is unguarded. Re-throws a
 * `cancelled` ceremony so the caller can abort.
 */
export async function createBackupPasskey(label?: string): Promise<boolean> {
  try {
    await enrollDeviceCredential(label ? { label } : {});
    setPhraseGuarded(true);
    return true;
  } catch (error) {
    if (
      error instanceof AuthError &&
      (error.code === "unsupported" || error.code === "origin-rejected")
    ) {
      setPhraseGuarded(false);
      return false;
    }
    throw error;
  }
}

export type PasskeyBackupReceipt = { user_id: string; rpId: string };

/**
 * Stores the current 32-byte local-first secret inside Jazz's resident,
 * user-verifying passkey backup. Unlike `createBackupPasskey`, this credential
 * can restore the account and is not merely a local phrase-reveal guard.
 */
export async function createRecoverablePasskeyBackup(
  displayName?: string,
): Promise<PasskeyBackupReceipt> {
  const runtime = await getRuntime();
  const user_id = runtime.db.getAuthState().session?.user_id;
  if (!user_id) throw new RecoverablePasskeyError("backup-failed");
  await backupSecretWithPasskey(
    createPasskeyBackupAdapter(),
    await currentSecret(),
    displayName?.trim() || `${getLofiApp().name} account ${user_id.slice(0, 8)}`,
  );
  setPasskeyRecoverable(true);
  return {
    user_id,
    rpId: getLofiApp().passkey?.rpId?.trim() || globalThis.location?.hostname || "localhost",
  };
}

/**
 * Runs the user-verifying passkey ceremony that must precede revealing the phrase
 * on a guarded device. A no-op when the device is not guarded. Throws `cancelled`
 * if the user dismisses the prompt — the phrase is then not revealed.
 */
export async function confirmPhraseAccess(): Promise<void> {
  if (!phraseGuarded()) return;
  await authenticateDeviceCredential();
}

/**
 * Reveals the current account's recovery phrase — the same 32-byte secret encoded
 * as words. Show it for the user to write down; never persist it. Works whether
 * or not sync is on, but only matters once the account syncs, since the phrase
 * recovers what has been backed up.
 */
export async function revealRecoveryPhrase(): Promise<string> {
  return toRecoveryPhrase(await currentSecret());
}

/**
 * Elects to back up and sync this account: replication to the managed Jazz app
 * turns on and the existing local data pushes up under the same identity. Pair
 * it with {@link revealRecoveryPhrase} so the user has a way back in. No-op when
 * no Jazz app is configured.
 */
export async function enableSyncBackup(): Promise<Session> {
  const canReconnect = typeof localStorage !== "undefined" &&
    localStorage.getItem(managedRuntimeKey) === "1";
  setSyncElected(true);
  if (canReconnect && runtimeCanReconnect()) {
    await (await getRuntime()).db.reconnect();
  } else {
    try {
      localStorage.setItem(managedRuntimeKey, "1");
      if (!canReconnect) localStorage.setItem(migrateLocalRowsKey, "1");
    } catch {
      // Runtime mode remains authoritative when local metadata cannot persist.
    }
    if (typeof window !== "undefined" && typeof SharedWorker !== "undefined") {
      return await reloadBrowserRuntime();
    }
    await recreateRuntime();
  }
  globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
  return readSession();
}

/**
 * Stops replicating this account to the server and returns to local-only. The
 * local data and the account are untouched — this only detaches the network, so
 * electing to sync again resumes against the same account.
 */
export async function stopSyncBackup(): Promise<Session> {
  const runtime = await getRuntime();
  setSyncElected(false);
  await runtime.db.disconnect();
  globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
  return readSession();
}

/**
 * Recovers an account from its recovery phrase: the phrase reconstructs the
 * exact account secret, which replaces the one on this device. Sync is elected
 * so the recovered account's data syncs back down, and the runtime is recreated
 * to open it. Throws {@link RecoveryError} on a malformed phrase — the account is
 * never replaced with a fabricated secret.
 *
 * This overwrites whatever account this device currently holds, so a caller
 * should confirm the intent before discarding a local-only account's data.
 */
export type AccountReplacementOptions = {
  /** Explicit acknowledgement that a different local-only account may be discarded. */
  confirmLocalReplacement?: boolean;
};

export class AccountReplacementError extends Error {
  override readonly name = "AccountReplacementError";
  readonly code = "confirmation-required";
  constructor() {
    super(
      "Restoring would replace this device's local-only account. Confirm replacement only after saving any data that has not synced.",
    );
  }
}

async function replaceAccountSecret(
  secret: string,
  options: AccountReplacementOptions,
): Promise<Session> {
  const current = await currentSecret();
  if (current !== secret && !syncElected() && !options.confirmLocalReplacement) {
    throw new AccountReplacementError();
  }
  setSyncElected(true);
  try {
    localStorage.setItem(managedRuntimeKey, "1");
  } catch {
    // The restored runtime is still authoritative if metadata cannot persist.
  }
  await replaceRuntimePrincipal(secret);
  globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
  return readSession();
}

export async function restoreFromRecoveryPhrase(
  phrase: string,
  options: AccountReplacementOptions = {},
): Promise<Session> {
  return await replaceAccountSecret(fromRecoveryPhrase(phrase), options);
}

/** Restores a passkey-backed secret and recreates Jazz on that stable principal. */
export async function restoreFromPasskey(
  options: AccountReplacementOptions = {},
): Promise<Session> {
  const secret = await restoreSecretWithPasskey(createPasskeyBackupAdapter());
  setPasskeyRecoverable(true);
  return await replaceAccountSecret(secret, options);
}

/** True when an error is a recovery-phrase problem the user can fix and retry. */
export function isRecoveryError(error: unknown): error is RecoveryError {
  return error instanceof RecoveryError;
}

/** True when an error came from a passkey ceremony (enroll / confirm). */
export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}

export function isRecoverablePasskeyError(error: unknown): error is RecoverablePasskeyError {
  return error instanceof RecoverablePasskeyError;
}

export function isAccountReplacementError(error: unknown): error is AccountReplacementError {
  return error instanceof AccountReplacementError;
}
