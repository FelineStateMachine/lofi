/**
 * The in-memory keyring for shared fields, mirroring the module-slot design
 * of the encrypted-column master key: synchronous column transforms can only
 * consult memory, so everything they need — the account's x25519 identity
 * now, unwrapped field keys as the read side lands — is installed by the
 * runtime before any database operation and read synchronously here.
 *
 * @module
 */
import { SharedFieldError } from "./shared-crypto.ts";

/** The account's shared-field identity, derived from the account secret. */
export type SharedFieldIdentity = {
  /** 32-byte x25519 static secret; never leaves memory. */
  secret: Uint8Array;
  /** The matching public key, self-published in the key directory. */
  publicKey: Uint8Array;
  /** base64url SHA-256 of the public key — the pinnable identity. */
  fingerprint: string;
};

let identity: SharedFieldIdentity | null = null;

/**
 * Installs the account's shared-field identity. The runtime calls this at
 * boot (after the encrypted-column key) and again whenever the account
 * secret changes; tests inject fixed identities.
 */
export function installSharedFieldIdentity(next: SharedFieldIdentity): void {
  if (next.secret.length !== 32 || next.publicKey.length !== 32) {
    throw new SharedFieldError(
      "identity-missing",
      "a shared-field identity needs 32-byte x25519 keys",
    );
  }
  identity = {
    secret: new Uint8Array(next.secret),
    publicKey: new Uint8Array(next.publicKey),
    fingerprint: next.fingerprint,
  };
}

/** The installed identity; throws `identity-missing` before boot installs it. */
export function requireSharedFieldIdentity(): SharedFieldIdentity {
  if (identity === null) {
    throw new SharedFieldError(
      "identity-missing",
      "shared fields were used before the account identity was installed",
    );
  }
  return identity;
}

/** The installed identity, or null before boot installs one. */
export function sharedFieldIdentityOrNull(): SharedFieldIdentity | null {
  return identity;
}

/** Forgets the installed identity; shared fields fail closed afterwards. */
export function clearSharedFieldIdentity(): void {
  identity = null;
}
