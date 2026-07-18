/**
 * Encrypted columns: field values are sealed on the client before they enter
 * Jazz, so the sync store holds ciphertext it cannot read. This is the
 * account-private half of field encryption (#126): the key derives from the
 * account secret, every device holding the account decrypts, and nobody else
 * — including the store operator — can. The store still sees structure
 * (tables, row identities, writers, timestamps, sizes); it stops seeing
 * content.
 *
 * Mechanics: an encrypted column is a stored `string` column whose
 * TypeScript-boundary transform seals on insert/update and opens on read
 * (XChaCha20-Poly1305; per-column subkeys via HKDF over the column label,
 * with the label bound as associated data so ciphertext cannot be replayed
 * across columns). Transforms are synchronous in the pinned engine, so the
 * cipher is the audited `@noble` implementation rather than WebCrypto.
 *
 * Constraints that fall out of the design, enforced or documented:
 * - The runtime installs the key at boot ({@link setEncryptedColumnKey});
 *   touching an encrypted column before that fails closed — plaintext is
 *   never written because a key was missing.
 * - Filters and policies address the stored representation. A `where` on an
 *   encrypted column compares ciphertext (useless, harmless); a permission
 *   policy must not reference one — the server cannot evaluate what it
 *   cannot read.
 * - Reading with the wrong account key (a shared row from another account)
 *   throws {@link EncryptedColumnError}. Encrypted columns belong in
 *   account-private tables until shared-field keys land (#126 Part 2).
 *
 * @module
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { schema, type StringColumn } from "jazz-tools";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Raised when an encrypted column cannot seal or open a value. */
export class EncryptedColumnError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "EncryptedColumnError";
  /**
   * `key-missing` — a column was used before the runtime installed the
   * account key. `key-invalid` — an installed key had the wrong shape.
   * `corrupt` — a stored value failed authentication: tampered, replayed
   * from another column, or sealed under a different account's key.
   */
  readonly code: "key-missing" | "key-invalid" | "corrupt";
  /** Creates an encrypted-column failure with a stable category. */
  constructor(code: "key-missing" | "key-invalid" | "corrupt", message: string) {
    super(message);
    this.code = code;
  }
}

// The 32-byte master key for this document's account, installed by the
// runtime before any database operation; per-label subkeys derive from it.
let masterKey: Uint8Array | null = null;
const labelKeys = new Map<string, Uint8Array>();

/**
 * Installs the account-derived 32-byte master key for encrypted columns.
 * The runtime calls this at boot (before creating the database client) and
 * again whenever the account secret changes; tests inject a fixed key.
 */
export function setEncryptedColumnKey(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new EncryptedColumnError("key-invalid", "the encrypted-column key must be 32 bytes");
  }
  masterKey = new Uint8Array(key);
  labelKeys.clear();
}

/** Forgets the installed key; encrypted columns fail closed afterwards. */
export function clearEncryptedColumnKey(): void {
  masterKey = null;
  labelKeys.clear();
}

function labelKey(label: string): Uint8Array {
  if (masterKey === null) {
    throw new EncryptedColumnError(
      "key-missing",
      `encrypted column "${label}" was used before the account key was installed`,
    );
  }
  const cached = labelKeys.get(label);
  if (cached) return cached;
  const derived = hkdf(sha256, masterKey, undefined, `lofi:encrypted-column:${label}`, 32);
  labelKeys.set(label, derived);
  return derived;
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

const STORED_PREFIX = "enc1.";
const NONCE_LENGTH = 24;

function seal(label: string, plaintext: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const cipher = xchacha20poly1305(
    labelKey(label),
    nonce,
    textEncoder.encode(`lofi:encrypted-column:${label}`),
  );
  const ciphertext = cipher.encrypt(textEncoder.encode(plaintext));
  const stored = new Uint8Array(NONCE_LENGTH + ciphertext.length);
  stored.set(nonce);
  stored.set(ciphertext, NONCE_LENGTH);
  return STORED_PREFIX + toBase64Url(stored);
}

function open(label: string, stored: string): string {
  if (typeof stored !== "string" || !stored.startsWith(STORED_PREFIX)) {
    throw new EncryptedColumnError(
      "corrupt",
      `encrypted column "${label}" holds a value without the sealed-format prefix`,
    );
  }
  const bytes = fromBase64Url(stored.slice(STORED_PREFIX.length));
  if (bytes.length <= NONCE_LENGTH) {
    throw new EncryptedColumnError(
      "corrupt",
      `encrypted column "${label}" holds a truncated value`,
    );
  }
  const cipher = xchacha20poly1305(
    labelKey(label),
    bytes.slice(0, NONCE_LENGTH),
    textEncoder.encode(`lofi:encrypted-column:${label}`),
  );
  try {
    return textDecoder.decode(cipher.decrypt(bytes.slice(NONCE_LENGTH)));
  } catch {
    throw new EncryptedColumnError(
      "corrupt",
      `encrypted column "${label}" failed authentication — sealed under a different account key, ` +
        "replayed from another column, or tampered with",
    );
  }
}

/**
 * A text column sealed on the client before it enters Jazz. `label` is the
 * column's stable identity, conventionally `"table.column"`; it domain-
 * separates the subkey and is bound as associated data, so changing it later
 * makes existing values unreadable — treat it like a column name.
 *
 * ```ts
 * notes: s.table({
 *   title: s.string(),
 *   body: s.encryptedText("notes.body"),
 * }),
 * ```
 */
export function encryptedText(label: string): StringColumn<false, false, string> {
  return schema.string().transform({
    to: (value: string) => seal(label, value),
    from: (value: string) => open(label, value),
  }) as unknown as StringColumn<false, false, string>;
}

/**
 * A JSON-value column sealed on the client before it enters Jazz; the view
 * type is the parsed value. Same label semantics as {@link encryptedText}.
 */
export function encryptedJson<T = unknown>(label: string): StringColumn<false, false, T> {
  return schema.string().transform({
    to: (value: T) => seal(label, JSON.stringify(value)),
    from: (value: string) => JSON.parse(open(label, value)) as T,
  }) as unknown as StringColumn<false, false, T>;
}
