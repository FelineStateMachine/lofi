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

// --- Field keys --------------------------------------------------------------
//
// Unwrapped group field keys, keyed by scope ("groupTable/groupId") and
// generation. The runtime's wrapped-key watcher installs entries as wraps
// arrive and sync; the synchronous column transforms read them here. A read
// whose (scope, generation) is absent surfaces as a pending state, never an
// exception — key-pending is the normal condition of a freshly added member.

const fieldKeys = new Map<string, Map<number, Uint8Array>>();
const keyringListeners = new Set<() => void>();

/** The keyring scope of a group resource: `"groupTable/groupId"`. */
export function sharedKeyScope(groupTable: string, groupId: string): string {
  return `${groupTable}/${groupId}`;
}

/** Installs an unwrapped field key and notifies keyring subscribers. */
export function installSharedFieldKey(
  scope: string,
  generation: number,
  key: Uint8Array,
): void {
  if (key.length !== 32) {
    throw new SharedFieldError("wrap-invalid", "a field key must be 32 bytes");
  }
  let generations = fieldKeys.get(scope);
  if (generations === undefined) {
    generations = new Map();
    fieldKeys.set(scope, generations);
  }
  const known = generations.get(generation);
  generations.set(generation, new Uint8Array(key));
  // Re-notification is what turns pending reads into plaintext; skip only
  // when the exact key was already present.
  if (known === undefined || !known.every((byte, index) => byte === key[index])) {
    for (const listener of [...keyringListeners]) listener();
  }
}

/** The installed key for a scope and generation, or null while pending. */
export function getSharedFieldKey(scope: string, generation: number): Uint8Array | null {
  return fieldKeys.get(scope)?.get(generation) ?? null;
}

/** The newest generation installed for a scope, or null when none is. */
export function latestSharedFieldGeneration(scope: string): number | null {
  const generations = fieldKeys.get(scope);
  if (generations === undefined || generations.size === 0) return null;
  return Math.max(...generations.keys());
}

/**
 * Subscribes to keyring changes. Live-query stores resubscribe on change so
 * rows previously surfaced as pending re-materialize into plaintext.
 */
export function subscribeSharedKeyring(listener: () => void): () => void {
  keyringListeners.add(listener);
  return () => {
    keyringListeners.delete(listener);
  };
}

/** Empties every installed field key; tests and logout call this. */
export function clearSharedFieldKeys(): void {
  fieldKeys.clear();
  for (const listener of [...keyringListeners]) listener();
}
