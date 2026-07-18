import { activeAppId } from "../runtime/config.ts";
import { getRuntime } from "../runtime/runtime.ts";
import { AccessError } from "./errors.ts";

/** App-scoped, non-secret Jazz principal identifier safe to copy between users. */
export type SharingIdentity = string & { readonly __lofiSharingIdentity: true };

const prefix = "lofi1";

/**
 * Encodes a raw Jazz principal as a versioned identity scoped to the active
 * sync location's app. Identities are exchanged between users of the same
 * store, so they carry the store's app id — the declared sink's when one is
 * enrolled, the compiled managed app's otherwise.
 */
export function encodeSharingIdentity(userId: string): SharingIdentity {
  if (!userId || /[\s:]/.test(userId)) {
    throw new AccessError("invalid-identity", "Jazz returned an invalid sharing identity.");
  }
  return `${prefix}:${activeAppId()}:${userId}` as SharingIdentity;
}

/**
 * Validates an app-scoped sharing identity and returns its raw Jazz principal.
 * Surrounding whitespace from copy/paste is tolerated; whitespace inside the
 * principal is rejected — a grant for a padded principal would look active to
 * the owner while never matching the recipient's actual account.
 */
export function decodeSharingIdentity(identity: string): string {
  const [version, identityAppId, userId, extra] = identity.trim().split(":");
  if (
    version !== prefix || identityAppId !== activeAppId() || !userId || /\s/.test(userId) ||
    extra !== undefined
  ) {
    throw new AccessError(
      "invalid-identity",
      "That sharing identity belongs to another app or is malformed. Ask the recipient to copy it again from this app.",
    );
  }
  return userId;
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
  return encodeSharingIdentity(userId);
}
