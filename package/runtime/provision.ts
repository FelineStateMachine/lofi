/**
 * Package-owned custody of the provision capability: the bearer URL of a
 * `provision`-scoped app ticket, which administers the store through the
 * node's gate by possession.
 *
 * Provision capability is deliberately custodied differently from the sync
 * declaration (`data-sink.ts`). Sync material opens silently at boot because
 * its theft is transport-only; provision material either persists behind a
 * passkey-PRF slot — opening is a user-verifying ceremony — or does not
 * persist at all. On a device whose authenticator cannot evaluate PRF, the
 * capability is held in memory for the session and the durable copy is the
 * ticket in the user's password manager; re-pasting it is the fallback, and
 * the node can mint a replacement, so the sealed copy is never the only one.
 *
 * The PRF gate converts silent theft of the stored capability into a prompted
 * ceremony; script running on the same origin can still request that ceremony
 * and hope the user approves it. That residual is a property of any
 * same-origin unlock and is documented, not hidden.
 *
 * @module
 */

import {
  authenticateAndDerivePrfSecret,
  type AuthenticateOptions,
  deriveAtRestKey,
} from "./auth.ts";
import { anchorAppId } from "./data-sink.ts";
import {
  EnvelopeError,
  fromBase64Url,
  openJsonEnvelope,
  parseSealedEnvelope,
  type PrfSlot,
  type SealedEnvelope,
  sealJsonEnvelope,
  toBase64Url,
} from "./envelope.ts";

const provisionKey = `lofi:provision:${anchorAppId}`;
const provisionPurpose = `lofi:provision:${anchorAppId}`;

// The capability in effect for this document: populated by enrollment (after
// a scope-down exchange), by sealing, or by a successful unlock ceremony.
let heldUrl: string | null = null;

/** What provision capability exists on this device right now. */
export type ProvisionCapabilityStatus = {
  /** The capability is usable in this document without a ceremony. */
  held: boolean;
  /** A PRF-sealed record exists at rest; unlocking is a passkey ceremony. */
  sealed: boolean;
  /** For a sealed record, whether its passkey roams across devices. */
  portable?: boolean;
};

function readSealedRecord(): SealedEnvelope | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(provisionKey);
    if (!raw) return null;
    const record = JSON.parse(raw) as { v?: number; sealed?: unknown } | null;
    if (record?.v !== 1) return null;
    return parseSealedEnvelope(record.sealed);
  } catch {
    return null;
  }
}

/** Reports what provision capability exists on this device. */
export function provisionCapabilityStatus(): ProvisionCapabilityStatus {
  const sealed = readSealedRecord();
  const prfSlot = sealed?.slots.find((slot): slot is PrfSlot => slot.type === "prf");
  return {
    held: heldUrl !== null,
    sealed: sealed !== null,
    ...(prfSlot?.portable !== undefined ? { portable: prfSlot.portable } : {}),
  };
}

/**
 * Holds the provision bearer URL in memory for this document only. This is
 * the no-ceremony path enrollment uses after a scope-down exchange, and the
 * whole custody story on devices that cannot seal: nothing reaches storage.
 */
export function holdProvisionCapability(url: string): void {
  heldUrl = url;
}

/** The capability held in this document, or `null` (sealed-only or absent). */
export function heldProvisionCapability(): string | null {
  return heldUrl;
}

/**
 * Forgets the in-memory capability while keeping any sealed record — the
 * lock half of the unlock ceremony, for callers that drop admin capability
 * after an operation rather than holding it for the document's lifetime.
 */
export function lockProvisionCapability(): void {
  heldUrl = null;
}

/** Forgets the held capability and removes any sealed record. */
export function clearProvisionCapability(): void {
  heldUrl = null;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(provisionKey);
  } catch {
    // A private-mode storage failure leaves the sealed record in place.
  }
}

/** What a completed sealing ceremony reports about the sealed record. */
export type SealOutcome = {
  /**
   * Whether the sealing passkey roams across the user's devices (a
   * password-manager or platform-synced credential) rather than being bound
   * to this one device — and with it, where the sealed record can unlock.
   */
  portable: boolean;
};

/**
 * Seals the held provision capability under a passkey-PRF slot in one
 * user-verifying ceremony. The PRF evaluation is attempted, never
 * capability-detected: on success the envelope records the credential that
 * actually evaluated it (and whether it roams); `prf-unavailable` or
 * `cancelled` propagate as `AuthError` so the caller can keep the capability
 * memory-only and point the user at their password manager instead.
 */
export async function sealProvisionCapability(
  options: AuthenticateOptions = {},
): Promise<SealOutcome> {
  if (heldUrl === null) {
    throw new EnvelopeError("locked", "no provision capability is held to seal");
  }
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const hkdfSalt = crypto.getRandomValues(new Uint8Array(32));
  const { credential, secret } = await authenticateAndDerivePrfSecret(
    prfSalt as BufferSource,
    options,
  );
  const key = await deriveAtRestKey(secret, `lofi-envelope:${provisionPurpose}`, hkdfSalt);
  secret.fill(0);
  const sealed = await sealJsonEnvelope(provisionPurpose, { url: heldUrl }, [{
    slot: {
      type: "prf",
      credentialId: credential.id,
      prfSalt: toBase64Url(prfSalt),
      hkdfSalt: toBase64Url(hkdfSalt),
      portable: credential.portable,
    },
    key,
  }]);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(provisionKey, JSON.stringify({ v: 1, sealed }));
    } catch {
      // A private-mode storage failure must not fail the ceremony; the
      // capability stays held for this document and the ticket in the user's
      // password manager remains the durable copy.
    }
  }
  return { portable: credential.portable };
}

/**
 * Unlocks the sealed provision capability through its passkey ceremony and
 * holds it for this document. Returns the held capability directly when one
 * is already in memory. Throws `EnvelopeError("locked")` when nothing is
 * stored, and `AuthError` (`cancelled`, `prf-unavailable`,
 * `credential-mismatch`) when the ceremony does not complete.
 */
export async function unlockProvisionCapability(
  options: AuthenticateOptions = {},
): Promise<string> {
  if (heldUrl !== null) return heldUrl;
  const sealed = readSealedRecord();
  if (!sealed) {
    throw new EnvelopeError("locked", "no provision capability is stored on this device");
  }
  const payload = await openJsonEnvelope(provisionPurpose, sealed, async (slot) => {
    if (slot.type !== "prf") return null;
    const { secret } = await authenticateAndDerivePrfSecret(
      fromBase64Url(slot.prfSalt) as BufferSource,
      { ...options, credentialId: slot.credentialId },
    );
    const key = await deriveAtRestKey(
      secret,
      `lofi-envelope:${provisionPurpose}`,
      fromBase64Url(slot.hkdfSalt),
    );
    secret.fill(0);
    return key;
  });
  const url = (payload as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || !url) {
    throw new EnvelopeError("corrupt", "the sealed provision record has no capability URL");
  }
  heldUrl = url;
  return url;
}
