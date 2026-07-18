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
import {
  activeSink,
  appId,
  setSyncElected,
  syncAvailable,
  syncElected,
  syncing,
} from "./config.ts";
import { declareSinkFromTicket } from "./data-sink.ts";
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
import { electManagedNamespace, readNamespaceState } from "./namespace-state.ts";

/** A non-secret description of the sync location in effect. */
export type SessionSink = {
  /** `declared` is a runtime-declared sink; `default` is the compiled managed app. */
  source: "declared" | "default";
  /** The sink host (never the full URL — a ticket URL is a bearer credential). */
  host: string;
  /** The user-facing label from enrollment, when one was given. */
  label?: string;
};

/** A snapshot of the account: what is possible and what the user has chosen. */
export type Session = {
  /** Stable, app-scoped Jazz sharing identity for the active account. */
  user_id: string | null;
  /** Whether a sync location exists (declared or compiled), so backup + sync is possible. */
  syncAvailable: boolean;
  /** The sync location in effect, or `null` while the device is local-only. */
  sink: SessionSink | null;
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

// The guard record pins the enrolled credential's id so the reveal ceremony
// accepts only that passkey. Legacy records stored the bare flag "1" — those
// devices stay guarded but unpinned until the guard is re-enrolled.
type PhraseGuard = { guarded: boolean; credentialId: string | null };

function readPhraseGuard(): PhraseGuard {
  if (typeof localStorage === "undefined") return { guarded: false, credentialId: null };
  try {
    const raw = localStorage.getItem(phraseGuardKey);
    if (!raw) return { guarded: false, credentialId: null };
    if (raw === "1") return { guarded: true, credentialId: null };
    try {
      const value = JSON.parse(raw) as { id?: unknown };
      return {
        guarded: true,
        credentialId: typeof value.id === "string" && value.id ? value.id : null,
      };
    } catch {
      return { guarded: true, credentialId: null };
    }
  } catch {
    return { guarded: false, credentialId: null };
  }
}

function phraseGuarded(): boolean {
  return readPhraseGuard().guarded;
}

function setPhraseGuard(credentialId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(phraseGuardKey, JSON.stringify({ id: credentialId }));
  } catch {
    // A private-mode storage failure must not break the ceremony itself.
  }
}

function clearPhraseGuard(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(phraseGuardKey);
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

function sessionSink(): SessionSink | null {
  const sink = activeSink();
  if (!sink) return null;
  let host: string;
  try {
    host = new URL(sink.serverUrl).host;
  } catch {
    host = "unknown";
  }
  return { source: sink.source, host, ...(sink.label ? { label: sink.label } : {}) };
}

/** Reads the current session. Synchronous — it never prompts or touches the network. */
export function readSession(): Session {
  return {
    user_id: getRuntimePrincipal(),
    syncAvailable: syncAvailable(),
    sink: sessionSink(),
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
    const credential = await enrollDeviceCredential(label ? { label } : {});
    setPhraseGuard(credential.id);
    return true;
  } catch (error) {
    if (
      error instanceof AuthError &&
      (error.code === "unsupported" || error.code === "origin-rejected")
    ) {
      // A failed re-enrollment must not remove a guard that already stands:
      // the existing credential still protects the reveal, so report the
      // device as guarded rather than silently downgrading it.
      if (readPhraseGuard().guarded) return true;
      clearPhraseGuard();
      return false;
    }
    throw error;
  }
}

/** Non-secret confirmation that a recoverable passkey was created for an account and RP-ID. */
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
 * on a guarded device. The ceremony is pinned to the enrolled credential, so no
 * other passkey for the same RP ID can satisfy it (guards enrolled before pinning
 * remain discoverable until re-enrolled). A no-op when the device is not guarded.
 * Throws `cancelled` if the user dismisses the prompt — the phrase is then not
 * revealed.
 */
export async function confirmPhraseAccess(): Promise<void> {
  const guard = readPhraseGuard();
  if (!guard.guarded) return;
  await authenticateDeviceCredential(
    guard.credentialId ? { credentialId: guard.credentialId } : {},
  );
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
  // The documented no-op: without a sync location there is nothing to sync
  // to, and electing the managed namespace anyway would hide the local rows
  // behind an empty database on every later boot.
  if (!syncAvailable()) return readSession();
  const alreadyManaged = readNamespaceState().mode === "managed";
  setSyncElected(true);
  if (alreadyManaged && runtimeCanReconnect()) {
    await (await getRuntime()).db.reconnect();
  } else {
    if (!alreadyManaged) electManagedNamespace({ migrateLocalRows: true });
    if (typeof window !== "undefined" && typeof SharedWorker !== "undefined") {
      return await reloadBrowserRuntime();
    }
    await recreateRuntime();
  }
  globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
  return readSession();
}

/**
 * Enrolls a `lofisync1.` app-connect ticket as this device's sync location and
 * elects to back up and sync in one step: the ticket's URL becomes the sync
 * server, the local data pushes up under the same identity, and the session
 * reflects the declared sink. Throws `DataSinkError` (see `data-sink.ts`) for
 * malformed tickets, ws URLs, an app id that contradicts a compiled-in managed
 * app, or a different sink already declared on this device.
 */
export async function enrollSyncTicket(ticket: string): Promise<Session> {
  declareSinkFromTicket(ticket);
  return await enableSyncBackup();
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

/** Confirmation required before recovery may replace a different local-only account. */
export type AccountReplacementOptions = {
  /** Explicit acknowledgement that a different local-only account may be discarded. */
  confirmLocalReplacement?: boolean;
};

/** Raised when account recovery needs explicit acknowledgement of local replacement. */
export class AccountReplacementError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "AccountReplacementError";
  /** Stable category for user-facing confirmation flows. */
  readonly code = "confirmation-required";
  /** Creates the non-secret replacement warning. */
  constructor() {
    super(
      "Restoring would replace this device's local-only account. Confirm replacement only after saving any data that has not synced.",
    );
  }
}

async function replaceAccountSecret(
  secret: string,
  options: AccountReplacementOptions,
  onConfirmed?: () => void,
): Promise<Session> {
  const current = await currentSecret();
  if (current === secret) {
    // The device already holds this account; there is no principal to replace.
    // Electing backup and sync is the whole remaining intent, and the election
    // path migrates a never-synced device's local rows instead of hiding them.
    onConfirmed?.();
    return await enableSyncBackup();
  }
  if (!syncElected() && !options.confirmLocalReplacement) {
    throw new AccountReplacementError();
  }
  onConfirmed?.();
  await replaceRuntimePrincipal(secret, {
    onSecretSaved: () => {
      // Commit election only after the restored secret is durably saved: a
      // replacement that fails earlier leaves the device booting its intact
      // local account instead of an empty managed namespace.
      if (!syncAvailable()) return;
      setSyncElected(true);
      electManagedNamespace({ migrateLocalRows: false });
    },
  });
  globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
  return readSession();
}

/**
 * Reconstructs an account from its recovery phrase, elects sync, and replaces
 * the active runtime. Throws {@link RecoveryError} for malformed phrases and
 * {@link AccountReplacementError} when confirmation is required.
 */
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
  // Recoverability is recorded only once replacement is confirmed: an aborted
  // restore must not leave metadata claiming this device's account is backed
  // up by the passkey that was merely asserted.
  return await replaceAccountSecret(secret, options, () => setPasskeyRecoverable(true));
}

/** True when an error is a recovery-phrase problem the user can fix and retry. */
export function isRecoveryError(error: unknown): error is RecoveryError {
  return error instanceof RecoveryError;
}

/** True when an error came from a passkey ceremony (enroll / confirm). */
export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}

/** True when an error came from a recoverable passkey backup or restore ceremony. */
export function isRecoverablePasskeyError(error: unknown): error is RecoverablePasskeyError {
  return error instanceof RecoverablePasskeyError;
}

/** True when recovery requires explicit confirmation before replacing a local account. */
export function isAccountReplacementError(error: unknown): error is AccountReplacementError {
  return error instanceof AccountReplacementError;
}
