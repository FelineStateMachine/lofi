/**
 * Runtime custody of shared-field identity: derives the account's x25519
 * keypair from the account secret at boot, self-publishes the public key in
 * the app's key directory, and pins peers' fingerprints on first sight so a
 * later substitution — the one active attack a key-relaying server has — is
 * a detected failure, not a silent read.
 *
 * @module
 */
import {
  publicKeyFingerprint,
  SharedFieldError,
  sharedFieldPublicKey,
  unwrapFieldKey,
} from "../schema/shared-crypto.ts";
import {
  clearSharedFieldIdentity,
  installSharedFieldIdentity,
  installSharedFieldKey,
  requireSharedFieldIdentity,
  type SharedFieldIdentity,
  sharedKeyScope,
} from "../schema/shared-keyring.ts";
import type { SharedColumnConfig } from "../schema/shared-registry.ts";

export { clearSharedFieldIdentity };

/**
 * Derives the account's shared-field identity from the account secret: the
 * same IKM convention as the encrypted-column master key with a distinct
 * HKDF info string, so the two hierarchies never share key material.
 */
export async function deriveSharedFieldIdentity(secret: string): Promise<SharedFieldIdentity> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0) as BufferSource,
      info: new TextEncoder().encode("lofi:shared-fields:x25519:v1") as BufferSource,
    },
    material,
    256,
  );
  const identitySecret = new Uint8Array(bits);
  const publicKey = sharedFieldPublicKey(identitySecret);
  return { secret: identitySecret, publicKey, fingerprint: publicKeyFingerprint(publicKey) };
}

/** Derives and installs the identity; the boot path calls this per client. */
export async function installSharedFieldIdentityFromSecret(secret: string): Promise<void> {
  installSharedFieldIdentity(await deriveSharedFieldIdentity(secret));
}

// --- Fingerprint pinning -----------------------------------------------------
//
// Trust-on-first-sight per device: the first fingerprint observed for a peer
// (or the one carried out-of-band in a lofi2 sharing identity, which never
// gives the server a first-sight window) is pinned in localStorage. A
// directory row that later disagrees is refused until the user explicitly
// re-trusts, which is the detection the threat model promises.

function pinStorageKey(appId: string): string {
  return `lofi:shared-fields:pins:${appId}`;
}

function readPins(appId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(pinStorageKey(appId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function writePins(appId: string, pins: Record<string, string>): void {
  try {
    localStorage.setItem(pinStorageKey(appId), JSON.stringify(pins));
  } catch {
    // Storage failures degrade to first-sight trust on the next read; the
    // unwrap path still authenticates cryptographically.
  }
}

/** The pinned fingerprint for a peer, if this device has seen one. */
export function pinnedFingerprint(appId: string, userId: string): string | undefined {
  return readPins(appId)[userId];
}

/**
 * Verifies a peer's observed fingerprint against this device's pin, pinning
 * on first sight. Returns false — and leaves the pin untouched — when a pin
 * exists and disagrees; callers refuse the key and surface the mismatch.
 */
export function verifyAndPinFingerprint(
  appId: string,
  userId: string,
  observed: string,
): boolean {
  const pins = readPins(appId);
  const pinned = pins[userId];
  if (pinned === undefined) {
    pins[userId] = observed;
    writePins(appId, pins);
    return true;
  }
  return pinned === observed;
}

/**
 * Replaces a peer's pin after out-of-band verification — the explicit user
 * action that resolves a `peer-key-changed` refusal.
 */
export function trustPeerKey(appId: string, userId: string, fingerprint: string): void {
  const pins = readPins(appId);
  pins[userId] = fingerprint;
  writePins(appId, pins);
}

/** Forgets every pin for an app; tests call this between scenarios. */
export function clearFingerprintPins(appId: string): void {
  try {
    localStorage.removeItem(pinStorageKey(appId));
  } catch {
    // Nothing to clear.
  }
}

// --- Directory self-publication ----------------------------------------------

type DirectoryRow = {
  id: string;
  user_id: string;
  algo: string;
  public_key: string;
  fingerprint: string;
};

type DirectoryDb = {
  all(query: unknown): Promise<unknown[]>;
  insert(
    table: unknown,
    values: Record<string, unknown>,
  ): { wait(options: { tier: "local" | "global" }): Promise<unknown> };
};

type DirectoryTable = {
  where(condition: Record<string, unknown>): unknown;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** The outcome of a directory self-publication attempt. */
export type DirectoryPublication =
  | { state: "published" }
  | { state: "existing" }
  | { state: "self-key-conflict"; expected: string; observed: string };

/**
 * Ensures the current account's public key is published in the app's key
 * directory: inserts on first sync, verifies on every later boot. A row that
 * exists with a *different* key is never overwritten — that shape means
 * directory tampering or a derivation bug, and silently replacing it would
 * hide exactly the event pinning exists to expose.
 */
export async function ensureDirectoryEntry(input: {
  db: DirectoryDb;
  directory: DirectoryTable;
  userId: string;
  identity: SharedFieldIdentity;
}): Promise<DirectoryPublication> {
  const rows = await input.db.all(
    input.directory.where({ user_id: input.userId }),
  ) as DirectoryRow[];
  const publicKey = toBase64Url(input.identity.publicKey);
  const existing = rows[0];
  if (existing !== undefined) {
    if (existing.public_key === publicKey) return { state: "existing" };
    return {
      state: "self-key-conflict",
      expected: publicKey,
      observed: existing.public_key,
    };
  }
  await input.db.insert(input.directory as never, {
    user_id: input.userId,
    algo: "x25519-v1",
    public_key: publicKey,
    fingerprint: input.identity.fingerprint,
  }).wait({ tier: "global" });
  return { state: "published" };
}

/** Decodes a directory row's public key, refusing malformed entries. */
export function directoryPublicKey(row: { public_key: string; algo: string }): Uint8Array {
  if (row.algo !== "x25519-v1") {
    throw new SharedFieldError(
      "wrap-invalid",
      `directory entry carries unsupported algorithm "${row.algo}"`,
    );
  }
  const base64 = row.public_key.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (bytes.length !== 32) {
    throw new SharedFieldError("wrap-invalid", "directory entry holds a malformed public key");
  }
  return bytes;
}

// --- Wrapped-key watcher -----------------------------------------------------

type WatcherDb = {
  subscribeAll(
    query: unknown,
    onDelta: (delta: { all: unknown[] }) => void,
    onError?: (error: unknown) => void,
  ): () => void;
  all(query: unknown): Promise<unknown[]>;
};

type WrappedKeyRow = {
  groupId: string;
  recipient_user_id: string;
  sender_user_id: string;
  generation: number;
  wrapped_key: string;
  sender_fingerprint: string;
};

/** One anomaly the watcher surfaces instead of installing a key. */
export type SharedFieldWatchAlert = {
  code: "peer-key-changed" | "wrap-invalid";
  userId: string;
  detail: string;
};

/**
 * Watches the wrapped-key tables named by the shared-column registry for
 * rows addressed to this account, resolves each sender's public key through
 * the pin store, unwraps, and installs field keys into the keyring. A sender
 * whose published key disagrees with its pin, or a wrap that fails
 * authentication, surfaces as an alert and installs nothing — refusing the
 * key IS the detection.
 *
 * Returns a teardown that closes every subscription.
 */
export function startSharedFieldKeyWatcher(input: {
  db: WatcherDb;
  appId: string;
  userId: string;
  configs: readonly SharedColumnConfig[];
  findTable(name: string): { where(condition: Record<string, unknown>): unknown } | null;
  onAlert(alert: SharedFieldWatchAlert): void;
}): () => void {
  const stops: Array<() => void> = [];
  const watched = new Set<string>();
  for (const config of input.configs) {
    const watchKey = `${config.keys}|${config.directory}|${config.group}`;
    if (watched.has(watchKey)) continue;
    watched.add(watchKey);
    const keysTable = input.findTable(config.keys);
    const directoryTable = input.findTable(config.directory);
    if (!keysTable || !directoryTable) {
      input.onAlert({
        code: "wrap-invalid",
        userId: input.userId,
        detail: `shared column "${config.label}" names undeclared table ` +
          `"${!keysTable ? config.keys : config.directory}"`,
      });
      continue;
    }
    const processed = new Set<string>();
    const stop = input.db.subscribeAll(
      keysTable.where({ recipient_user_id: input.userId }),
      (delta) => {
        for (const raw of delta.all as WrappedKeyRow[]) {
          const rowKey = `${config.group}/${raw.groupId}#${raw.generation}@${raw.sender_user_id}` +
            `:${raw.wrapped_key}`;
          if (processed.has(rowKey)) continue;
          processed.add(rowKey);
          void installWrappedKey(input, config, directoryTable, raw);
        }
      },
      () => {
        // Subscription errors surface through the live-query stores consumers
        // actually watch; the watcher retries on the next runtime recreation.
      },
    );
    stops.push(stop);
  }
  return () => {
    for (const stop of stops) stop();
  };
}

async function installWrappedKey(
  input: {
    db: WatcherDb;
    appId: string;
    userId: string;
    onAlert(alert: SharedFieldWatchAlert): void;
  },
  config: SharedColumnConfig,
  directoryTable: { where(condition: Record<string, unknown>): unknown },
  row: WrappedKeyRow,
): Promise<void> {
  try {
    const identity = requireSharedFieldIdentity();
    const entries = await input.db.all(
      directoryTable.where({ user_id: row.sender_user_id }),
    ) as Array<{ user_id: string; algo: string; public_key: string }>;
    const entry = entries[0];
    if (entry === undefined) {
      input.onAlert({
        code: "wrap-invalid",
        userId: row.sender_user_id,
        detail: `a wrap from ${row.sender_user_id} arrived before its directory entry`,
      });
      return;
    }
    const senderPublic = directoryPublicKey(entry);
    const observedFingerprint = publicKeyFingerprint(senderPublic);
    if (!verifyAndPinFingerprint(input.appId, row.sender_user_id, observedFingerprint)) {
      input.onAlert({
        code: "peer-key-changed",
        userId: row.sender_user_id,
        detail: `the published key for ${row.sender_user_id} no longer matches its pin; ` +
          "refusing its wraps until the key is re-trusted",
      });
      return;
    }
    if (row.sender_fingerprint !== observedFingerprint) {
      input.onAlert({
        code: "wrap-invalid",
        userId: row.sender_user_id,
        detail: "a wrap's declared sender fingerprint disagrees with the directory",
      });
      return;
    }
    const fieldKey = unwrapFieldKey({
      wrapped: row.wrapped_key,
      recipientSecret: identity.secret,
      senderPublic,
      context: {
        groupTable: config.group,
        groupId: row.groupId,
        generation: row.generation,
        recipientUserId: input.userId,
        senderUserId: row.sender_user_id,
      },
    });
    installSharedFieldKey(sharedKeyScope(config.group, row.groupId), row.generation, fieldKey);
  } catch (error) {
    input.onAlert({
      code: "wrap-invalid",
      userId: row.sender_user_id,
      detail: error instanceof SharedFieldError
        ? error.message
        : `a wrap failed to install: ${String(error)}`,
    });
  }
}
