import { appId } from "../runtime/config.ts";
import { getRuntime } from "../runtime/runtime.ts";
import { AccessError } from "./errors.ts";

declare const sharingIdentityBrand: unique symbol;
export type SharingIdentity = string & { readonly [sharingIdentityBrand]: true };

const prefix = "lofi1";

export function encodeSharingIdentity(userId: string): SharingIdentity {
  if (!userId.trim() || userId.includes(":")) {
    throw new AccessError("invalid-identity", "Jazz returned an invalid sharing identity.");
  }
  return `${prefix}:${appId}:${userId}` as SharingIdentity;
}

export function decodeSharingIdentity(identity: string): string {
  const [version, identityAppId, userId, extra] = identity.split(":");
  if (version !== prefix || identityAppId !== appId || !userId || extra !== undefined) {
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
