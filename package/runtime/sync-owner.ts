/**
 * Package-owned sync-owner pin: the per-device record that binds the sync
 * election to the account that made it.
 *
 * Every other sync key on a device (election flag, sealed sink, namespace
 * record) is scoped to the app alone, so replacing the account secret would
 * otherwise leave a different identity syncing into the previous owner's
 * store. The owner record closes that hole: electing sync records the
 * electing account's fingerprint, and a boot whose account does not match
 * refuses to connect and surfaces the mismatch instead of merging stores.
 *
 * The fingerprint is the same SHA-256/8-byte derivation that names the
 * account's storage namespace — already treated as non-secret — so the
 * verdict is computable before any client is created and the guard closes
 * with no window where a foreign account is briefly connected.
 *
 * @module
 */

import { anchorAppId } from "./data-sink.ts";

const ownerKey = `lofi:sync-owner:${anchorAppId}`;

/** The persisted sync-owner pin for this device. */
export type SyncOwnerRecord = {
  /** The owning account's secret fingerprint (namespace derivation). */
  fingerprint: string;
  /**
   * The owner's sync principal for display surfaces, or `null` until the
   * first successful managed boot backfills it. Never used for adjudication.
   */
  user_id: string | null;
};

/**
 * The non-secret account fingerprint: SHA-256 of the secret, first 8 bytes,
 * lowercase hex. Byte-identical to the account's storage-namespace name.
 */
export async function secretFingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The owner verdict for the account in hand. `unadjudicated` is the state
 * before any adjudication this document; `unclaimed` means no owner record
 * exists; `self` means the account is the owner; `foreign` means sync on this
 * device belongs to a different account.
 */
export type SyncOwnerVerdict =
  | { state: "unadjudicated" }
  | { state: "unclaimed" }
  | { state: "self" }
  | { state: "foreign"; owner_user_id: string | null };

let lastVerdict: SyncOwnerVerdict = { state: "unadjudicated" };

/** Reads the persisted owner record, or `null` when sync is unclaimed. */
export function readSyncOwner(): SyncOwnerRecord | null {
  if (typeof localStorage === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ownerKey);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as { v?: number; fingerprint?: unknown; user_id?: unknown };
    if (record?.v !== 1 || typeof record.fingerprint !== "string" || !record.fingerprint) {
      return null;
    }
    return {
      fingerprint: record.fingerprint,
      user_id: typeof record.user_id === "string" ? record.user_id : null,
    };
  } catch {
    return null;
  }
}

/** Persists the owner record. A private-mode storage failure is non-fatal. */
export function recordSyncOwner(record: SyncOwnerRecord): void {
  lastVerdict = { state: "self" };
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      ownerKey,
      JSON.stringify({ v: 1, fingerprint: record.fingerprint, user_id: record.user_id }),
    );
  } catch {
    // The pin then lasts for this document only; the election it accompanies
    // is equally document-scoped in that context.
  }
}

/** Removes the owner record — the stop-sync half of the pin's lifecycle. */
export function clearSyncOwner(): void {
  lastVerdict = { state: "unadjudicated" };
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(ownerKey);
  } catch {
    // A private-mode storage failure leaves the previous record in place.
  }
}

/** Adjudicates a fingerprint against the persisted owner record. */
export function adjudicateSyncOwner(fingerprint: string): SyncOwnerVerdict {
  const record = readSyncOwner();
  lastVerdict = record === null
    ? { state: "unclaimed" }
    : record.fingerprint === fingerprint
    ? { state: "self" }
    : { state: "foreign", owner_user_id: record.user_id };
  return lastVerdict;
}

/** The most recent adjudication this document, for synchronous session reads. */
export function readSyncOwnerVerdict(): SyncOwnerVerdict {
  return lastVerdict;
}

/**
 * Thrown by `enableSyncBackup` (and through it `enrollSyncTicket`) when sync
 * on this device was elected by a different account than the one in hand. The
 * message is user-presentable and names the remediation: stop sync (which
 * releases the pin) or restore the owning account, then elect again. The same
 * mismatch found at boot never throws — the runtime opens with transport
 * suppressed and reports it through the session's `syncOwnerMismatch` flag
 * and the `syncOwner` runtime diagnostic instead, so local work continues.
 */
export class SyncOwnerError extends Error {
  /** Stable error class name for diagnostics and UI boundaries. */
  override readonly name = "SyncOwnerError";
  /** Stable category for user-facing branches. */
  readonly code = "owner-mismatch";
  /**
   * The owning account's sync principal for display surfaces, or `null` when
   * the owner elected before its first managed boot named it. Matches the
   * `user_id` vocabulary the session relays.
   */
  readonly owner_user_id: string | null;

  /** Creates the non-secret refusal, naming the owning account when known. */
  constructor(owner_user_id: string | null) {
    super(
      "Sync on this device was set up by a different account. Stop syncing to release it, " +
        "or restore the owning account, then enable sync again.",
    );
    this.owner_user_id = owner_user_id;
  }
}

/** True when an error is the sync-owner refusal (see {@link SyncOwnerError}). */
export function isSyncOwnerError(error: unknown): error is SyncOwnerError {
  return error instanceof SyncOwnerError;
}
