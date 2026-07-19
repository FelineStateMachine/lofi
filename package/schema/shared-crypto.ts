/**
 * Shared-field crypto core: the primitives that let a field key travel to
 * every member of a group as ordinary synced data the server cannot open.
 *
 * Two formats live here. `wrap1` is an authenticated key wrap: a random
 * 32-byte field key sealed to one recipient's x25519 public key, with the
 * sender's static key mixed into the derivation, so the server — which knows
 * every public key — cannot mint a wrap of its own; forging one requires a
 * member's secret. `encs1` is the sealed column value: XChaCha20-Poly1305
 * under a per-column subkey of the field key, with the key scope (group
 * table, group id, generation) carried in the stored string, because the
 * synchronous column transform sees only the value and must pick the right
 * key from an in-memory keyring.
 *
 * Both formats bind their full context as associated data — a wrap replayed
 * to another group, recipient, or generation, and a sealed value replayed to
 * another column or scope, fail authentication rather than decrypt.
 *
 * @module
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { padPayload, unpadPayload } from "./padding.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Raised when shared-field material cannot be derived, wrapped, or opened. */
export class SharedFieldError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "SharedFieldError";
  /**
   * `identity-missing` — a shared column was touched before the runtime
   * installed the account's x25519 identity. `key-pending` — no field key is
   * installed for the value's scope and generation yet; a normal state for a
   * freshly added member. `unscoped-write` — a write reached the column
   * transform without the mutation layer sealing it first. `corrupt` — a
   * sealed value failed authentication. `peer-key-changed` — a peer's
   * published public key no longer matches its pinned fingerprint.
   * `wrap-invalid` — a wrapped key failed authentication or shape checks.
   * `no-directory-entry` — a wrap was requested for an account that has not
   * published a public key.
   */
  readonly code:
    | "identity-missing"
    | "key-pending"
    | "unscoped-write"
    | "corrupt"
    | "peer-key-changed"
    | "wrap-invalid"
    | "no-directory-entry";
  /** Creates a shared-field failure with a stable category. */
  constructor(code: SharedFieldError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** The x25519 public key of a shared-field identity secret. */
export function sharedFieldPublicKey(identitySecret: Uint8Array): Uint8Array {
  if (identitySecret.length !== 32) {
    throw new SharedFieldError("identity-missing", "the x25519 identity secret must be 32 bytes");
  }
  return x25519.getPublicKey(identitySecret);
}

/**
 * The pinnable fingerprint of a public key: base64url(SHA-256(key)). This is
 * the value carried in `lofi2` sharing-identity strings and compared by the
 * pin store.
 */
export function publicKeyFingerprint(publicKey: Uint8Array): string {
  return toBase64Url(sha256(publicKey));
}

/** Mints a random 32-byte field key. */
export function generateFieldKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** The row context a wrapped key is bound to; any mismatch refuses to open. */
export type WrapContext = {
  groupTable: string;
  groupId: string;
  generation: number;
  recipientUserId: string;
  senderUserId: string;
};

const WRAP_PREFIX = "wrap1.";
const WRAP_INFO = "lofi:shared-fields:wrap:v1";
const NONCE_LENGTH = 24;
const KEY_LENGTH = 32;

function wrapAssociatedData(context: WrapContext): Uint8Array {
  return textEncoder.encode(
    `${WRAP_INFO}|${context.groupTable}|${context.groupId}|${context.generation}|` +
      `${context.recipientUserId}|${context.senderUserId}`,
  );
}

function wrapKeyMaterial(
  ephemeralPublic: Uint8Array,
  senderPublic: Uint8Array,
  recipientPublic: Uint8Array,
  sharedEphemeral: Uint8Array,
  sharedStatic: Uint8Array,
): Uint8Array {
  return hkdf(
    sha256,
    concatBytes(sharedEphemeral, sharedStatic),
    concatBytes(ephemeralPublic, senderPublic, recipientPublic),
    WRAP_INFO,
    KEY_LENGTH,
  );
}

/**
 * Wraps a field key to one recipient. The derivation mixes an ephemeral
 * exchange with the sender's static key (authcrypt): the recipient verifies
 * the wrap could only come from the holder of the sender's secret, so a
 * server that knows every public key still cannot forge one.
 */
export function wrapFieldKey(input: {
  fieldKey: Uint8Array;
  senderSecret: Uint8Array;
  recipientPublic: Uint8Array;
  context: WrapContext;
}): string {
  if (input.fieldKey.length !== KEY_LENGTH) {
    throw new SharedFieldError("wrap-invalid", "the field key must be 32 bytes");
  }
  const senderPublic = sharedFieldPublicKey(input.senderSecret);
  const ephemeralSecret = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const key = wrapKeyMaterial(
    ephemeralPublic,
    senderPublic,
    input.recipientPublic,
    x25519.getSharedSecret(ephemeralSecret, input.recipientPublic),
    x25519.getSharedSecret(input.senderSecret, input.recipientPublic),
  );
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const cipher = xchacha20poly1305(key, nonce, wrapAssociatedData(input.context));
  const ciphertext = cipher.encrypt(input.fieldKey);
  return WRAP_PREFIX + toBase64Url(concatBytes(ephemeralPublic, nonce, ciphertext));
}

/**
 * Opens a wrapped field key as its recipient. `senderPublic` must be the
 * sender's pinned public key — resolving it through the pin store is what
 * turns server key substitution into a detected failure here.
 */
export function unwrapFieldKey(input: {
  wrapped: string;
  recipientSecret: Uint8Array;
  senderPublic: Uint8Array;
  context: WrapContext;
}): Uint8Array {
  if (!input.wrapped.startsWith(WRAP_PREFIX)) {
    throw new SharedFieldError("wrap-invalid", "a wrapped key must carry the wrap1 prefix");
  }
  const bytes = fromBase64Url(input.wrapped.slice(WRAP_PREFIX.length));
  if (bytes.length <= KEY_LENGTH + NONCE_LENGTH) {
    throw new SharedFieldError("wrap-invalid", "a wrapped key is truncated");
  }
  const ephemeralPublic = bytes.slice(0, KEY_LENGTH);
  const nonce = bytes.slice(KEY_LENGTH, KEY_LENGTH + NONCE_LENGTH);
  const recipientPublic = sharedFieldPublicKey(input.recipientSecret);
  const key = wrapKeyMaterial(
    ephemeralPublic,
    input.senderPublic,
    recipientPublic,
    x25519.getSharedSecret(input.recipientSecret, ephemeralPublic),
    x25519.getSharedSecret(input.recipientSecret, input.senderPublic),
  );
  const cipher = xchacha20poly1305(key, nonce, wrapAssociatedData(input.context));
  try {
    const fieldKey = cipher.decrypt(bytes.slice(KEY_LENGTH + NONCE_LENGTH));
    if (fieldKey.length !== KEY_LENGTH) {
      throw new SharedFieldError("wrap-invalid", "a wrapped key opened to the wrong length");
    }
    return fieldKey;
  } catch (error) {
    if (error instanceof SharedFieldError) throw error;
    throw new SharedFieldError(
      "wrap-invalid",
      "a wrapped key failed authentication — forged sender, substituted key, replayed " +
        "context, or tampered bytes",
    );
  }
}

/** The key scope a sealed shared value belongs to. */
export type SharedValueScope = {
  groupTable: string;
  groupId: string;
  generation: number;
};

const SEALED_PREFIX = "encs1.";
const COLUMN_INFO = "lofi:shared-field:column:";

function assertScopeSegment(kind: string, value: string): void {
  if (!value || value.includes(".")) {
    throw new SharedFieldError(
      "unscoped-write",
      `a shared-field ${kind} must be non-empty and must not contain "." (got "${value}")`,
    );
  }
}

function columnKey(fieldKey: Uint8Array, label: string): Uint8Array {
  return hkdf(sha256, fieldKey, undefined, `${COLUMN_INFO}${label}`, KEY_LENGTH);
}

function sealedAssociatedData(label: string, scope: SharedValueScope): Uint8Array {
  return textEncoder.encode(
    `lofi:shared-field:${label}|${scope.groupTable}|${scope.groupId}|${scope.generation}`,
  );
}

/**
 * Seals a shared column value under a field key. The stored string carries
 * the scope and generation so the synchronous open path can pick the right
 * key from the keyring.
 */
export function sealSharedValue(input: {
  plaintext: string;
  fieldKey: Uint8Array;
  label: string;
  scope: SharedValueScope;
}): string {
  assertScopeSegment("group table", input.scope.groupTable);
  assertScopeSegment("group id", input.scope.groupId);
  if (!Number.isInteger(input.scope.generation) || input.scope.generation < 1) {
    throw new SharedFieldError(
      "unscoped-write",
      `a shared-field generation must be a positive integer (got ${input.scope.generation})`,
    );
  }
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const cipher = xchacha20poly1305(
    columnKey(input.fieldKey, input.label),
    nonce,
    sealedAssociatedData(input.label, input.scope),
  );
  const ciphertext = cipher.encrypt(padPayload(textEncoder.encode(input.plaintext)));
  return `${SEALED_PREFIX}${input.scope.groupTable}.${input.scope.groupId}.` +
    `${input.scope.generation}.${toBase64Url(concatBytes(nonce, ciphertext))}`;
}

/** The parsed shape of a stored `encs1.` value. */
export type ParsedSharedValue = {
  scope: SharedValueScope;
  payload: Uint8Array;
};

/**
 * Parses a stored shared value into its scope and sealed payload, or returns
 * null when the value does not carry the shared-value prefix.
 */
export function parseSharedValue(stored: string): ParsedSharedValue | null {
  if (typeof stored !== "string" || !stored.startsWith(SEALED_PREFIX)) return null;
  const body = stored.slice(SEALED_PREFIX.length);
  const segments = body.split(".");
  if (segments.length !== 4) return null;
  const [groupTable, groupId, generationText, payloadText] = segments;
  const generation = Number(generationText);
  if (!groupTable || !groupId || !Number.isInteger(generation) || generation < 1) return null;
  return { scope: { groupTable, groupId, generation }, payload: fromBase64Url(payloadText) };
}

/** Opens a sealed shared value with the field key its scope names. */
export function openSharedValue(input: {
  stored: string;
  fieldKey: Uint8Array;
  label: string;
}): string {
  const parsed = parseSharedValue(input.stored);
  if (parsed === null) {
    throw new SharedFieldError(
      "corrupt",
      `shared column "${input.label}" holds a value without the sealed-format prefix`,
    );
  }
  if (parsed.payload.length <= NONCE_LENGTH) {
    throw new SharedFieldError("corrupt", `shared column "${input.label}" holds a truncated value`);
  }
  const cipher = xchacha20poly1305(
    columnKey(input.fieldKey, input.label),
    parsed.payload.slice(0, NONCE_LENGTH),
    sealedAssociatedData(input.label, parsed.scope),
  );
  try {
    return textDecoder.decode(unpadPayload(cipher.decrypt(parsed.payload.slice(NONCE_LENGTH))));
  } catch {
    throw new SharedFieldError(
      "corrupt",
      `shared column "${input.label}" failed authentication — sealed under a different key, ` +
        "replayed from another column or scope, or tampered with",
    );
  }
}
