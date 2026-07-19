import { activeAppId } from "../runtime/config.ts";
import { getRuntime } from "../runtime/runtime.ts";
import { sharedFieldIdentityOrNull } from "../schema/shared-keyring.ts";
import { AccessError } from "./errors.ts";

/** App-scoped, non-secret Jazz principal identifier safe to copy between users. */
export type SharingIdentity = string & { readonly __lofiSharingIdentity: true };

const prefix = "lofi1";
const prefixWithFingerprint = "lofi2";

/** A decoded sharing identity: the raw principal, and — when the identity
 * was minted by a shared-field-capable app — the account's public-key
 * fingerprint. A carried fingerprint pins the peer's key out-of-band, so the
 * sync server never gets a first-sight window for that relationship. */
export type SharingIdentityDetails = {
  userId: string;
  fingerprint?: string;
};

/**
 * Encodes a raw Jazz principal as a versioned identity scoped to the active
 * sync location's app. Identities are exchanged between users of the same
 * store, so they carry the store's app id — the declared sink's when one is
 * enrolled, the compiled managed app's otherwise. With a fingerprint, the
 * identity also carries the account's shared-field key fingerprint.
 */
export function encodeSharingIdentity(userId: string, fingerprint?: string): SharingIdentity {
  if (!userId || /[\s:]/.test(userId)) {
    throw new AccessError("invalid-identity", "Jazz returned an invalid sharing identity.");
  }
  if (fingerprint === undefined) {
    return `${prefix}:${activeAppId()}:${userId}` as SharingIdentity;
  }
  if (!fingerprint || /[\s:]/.test(fingerprint)) {
    throw new AccessError("invalid-identity", "The identity fingerprint is malformed.");
  }
  return `${prefixWithFingerprint}:${activeAppId()}:${userId}:${fingerprint}` as SharingIdentity;
}

/**
 * Validates an app-scoped sharing identity and returns its parts. Both
 * identity versions decode: `lofi1` yields the principal alone, `lofi2` adds
 * the fingerprint. Surrounding whitespace from copy/paste is tolerated;
 * whitespace inside the principal is rejected — a grant for a padded
 * principal would look active to the owner while never matching the
 * recipient's actual account.
 */
export function decodeSharingIdentityDetails(identity: string): SharingIdentityDetails {
  const [version, identityAppId, userId, fingerprint, extra] = identity.trim().split(":");
  const malformed = new AccessError(
    "invalid-identity",
    "That sharing identity belongs to another app or is malformed. Ask the recipient to copy it again from this app.",
  );
  if (identityAppId !== activeAppId() || !userId || /\s/.test(userId) || extra !== undefined) {
    throw malformed;
  }
  if (version === prefix) {
    if (fingerprint !== undefined) throw malformed;
    return { userId };
  }
  if (version === prefixWithFingerprint) {
    if (!fingerprint || /\s/.test(fingerprint)) throw malformed;
    return { userId, fingerprint };
  }
  throw malformed;
}

/** Validates a sharing identity and returns its raw Jazz principal. */
export function decodeSharingIdentity(identity: string): string {
  return decodeSharingIdentityDetails(identity).userId;
}

/** Returns the non-secret, app-scoped identity users may copy for shares. */
export async function sharingIdentity(): Promise<SharingIdentity> {
  const runtime = await getRuntime();
  const userId = runtime.db.getAuthState().session?.user_id;
  if (!userId) {
    throw new AccessError(
      "invalid-identity",
      "The current Jazz principal is not ready. Wait for account startup and try again.",
    );
  }
  // Once the shared-field identity is installed, minted identities carry the
  // fingerprint so recipients pin this account's key person-to-person.
  return encodeSharingIdentity(userId, sharedFieldIdentityOrNull()?.fingerprint);
}
