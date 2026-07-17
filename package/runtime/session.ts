/**
// Package-owned account session runtime.
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
import { appId, setSyncElected, syncAvailable, syncElected, syncing } from "./config.ts";
import { fromRecoveryPhrase, RecoveryError, toRecoveryPhrase } from "./recovery.ts";
import { authenticateDeviceCredential, AuthError, enrollDeviceCredential } from "./auth.ts";
import { recreateRuntime, runtimeRecreatedEvent } from "./runtime.ts";

/** A snapshot of the account: what is possible and what the user has chosen. */
export type Session = {
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
};

// A per-device flag recording that the user enrolled a passkey to guard the
// recovery phrase. The passkey itself is a resident credential on the device;
// this only remembers to ask for it before revealing the phrase.
const phraseGuardKey = `lofi:phrase-passkey:${appId}`;

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

/** Reads the current session. Synchronous — it never prompts or touches the network. */
export function readSession(): Session {
  return {
    syncAvailable,
    backedUp: syncElected(),
    syncing: syncing(),
    phraseGuarded: phraseGuarded(),
  };
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
  setSyncElected(true);
  await recreateRuntime();
  globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
  return readSession();
}

/**
 * Stops replicating this account to the server and returns to local-only. The
 * local data and the account are untouched — this only detaches the network, so
 * electing to sync again resumes against the same account.
 */
export async function stopSyncBackup(): Promise<Session> {
  setSyncElected(false);
  await recreateRuntime();
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
export async function restoreFromRecoveryPhrase(phrase: string): Promise<Session> {
  const secret = fromRecoveryPhrase(phrase);
  await BrowserAuthSecretStore.saveSecret(secret, { appId });
  setSyncElected(true);
  await recreateRuntime();
  globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
  return readSession();
}

/** True when an error is a recovery-phrase problem the user can fix and retry. */
export function isRecoveryError(error: unknown): error is RecoveryError {
  return error instanceof RecoveryError;
}

/** True when an error came from a passkey ceremony (enroll / confirm). */
export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
