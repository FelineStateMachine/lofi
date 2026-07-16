/**
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
import { recreateRuntime, runtimeRecreatedEvent } from "./runtime.ts";

/** A snapshot of the account: what is possible and what the user has chosen. */
export type Session = {
  /** Whether a managed Jazz app is configured, so backup + sync is possible at all. */
  syncAvailable: boolean;
  /** Whether the user has elected to back up and sync this account on this device. */
  backedUp: boolean;
  /** Whether writes replicate right now (available *and* elected). */
  syncing: boolean;
};

/** Reads the current session. Synchronous — it never prompts or touches the network. */
export function readSession(): Session {
  return { syncAvailable, backedUp: syncElected(), syncing: syncing() };
}

// The account secret the runtime is already using. `getOrCreateSecret` is a
// read-through: the runtime created it on first boot, so this returns that same
// secret rather than minting a new one.
async function currentSecret(): Promise<string> {
  return await BrowserAuthSecretStore.getOrCreateSecret({ appId });
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
