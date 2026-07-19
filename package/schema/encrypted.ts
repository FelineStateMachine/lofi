/**
 * Encrypted columns: field values are sealed on the client before they enter
 * Jazz, so the sync store holds ciphertext it cannot read. The key derives
 * from the account secret, every device holding the account decrypts, and
 * nobody else — including the store operator — can. The store still sees structure
 * (tables, row identities, writers, timestamps, sizes); it stops seeing
 * content.
 *
 * Mechanics: an encrypted column is a stored `string` column whose
 * TypeScript-boundary transform seals on insert/update and opens on read
 * (XChaCha20-Poly1305; per-column subkeys via HKDF over the column label,
 * with the label and format version bound as associated data so ciphertext
 * cannot be replayed across columns or format versions). Transforms are
 * synchronous in the pinned engine, so the cipher is the audited `@noble`
 * implementation rather than WebCrypto.
 *
 * Plaintext is padded to bucket sizes before sealing ({@link ../padding.ts}),
 * so the store sees a size class, not an exact content length. New values are
 * written in the padded `enc2.` format; legacy unpadded `enc1.` values remain
 * readable and re-seal as `enc2.` on their next write.
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
 *   account-private tables; fields shared across accounts need a shared key,
 *   which this module does not provide.
 *
 * @module
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { schema, type StringColumn } from "jazz-tools";
import { padPayload, unpadPayload } from "./padding.ts";

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

const LEGACY_PREFIX = "enc1.";
const STORED_PREFIX = "enc2.";
const NONCE_LENGTH = 24;

// The format version is bound as associated data because the prefix sits
// outside the AEAD: without it, rewriting one prefix into the other would
// hand the wrong unpacking to an authenticated plaintext.
function associatedData(label: string, prefix: string): Uint8Array {
  return textEncoder.encode(
    prefix === LEGACY_PREFIX
      ? `lofi:encrypted-column:${label}`
      : `lofi:encrypted-column:enc2:${label}`,
  );
}

function seal(label: string, plaintext: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const cipher = xchacha20poly1305(labelKey(label), nonce, associatedData(label, STORED_PREFIX));
  const ciphertext = cipher.encrypt(padPayload(textEncoder.encode(plaintext)));
  const stored = new Uint8Array(NONCE_LENGTH + ciphertext.length);
  stored.set(nonce);
  stored.set(ciphertext, NONCE_LENGTH);
  return STORED_PREFIX + toBase64Url(stored);
}

function open(label: string, stored: string): string {
  const prefix = typeof stored === "string" && stored.startsWith(STORED_PREFIX)
    ? STORED_PREFIX
    : typeof stored === "string" && stored.startsWith(LEGACY_PREFIX)
    ? LEGACY_PREFIX
    : null;
  if (prefix === null) {
    throw new EncryptedColumnError(
      "corrupt",
      `encrypted column "${label}" holds a value without the sealed-format prefix`,
    );
  }
  const bytes = fromBase64Url(stored.slice(prefix.length));
  if (bytes.length <= NONCE_LENGTH) {
    throw new EncryptedColumnError(
      "corrupt",
      `encrypted column "${label}" holds a truncated value`,
    );
  }
  const cipher = xchacha20poly1305(
    labelKey(label),
    bytes.slice(0, NONCE_LENGTH),
    associatedData(label, prefix),
  );
  try {
    const plaintext = cipher.decrypt(bytes.slice(NONCE_LENGTH));
    return textDecoder.decode(prefix === STORED_PREFIX ? unpadPayload(plaintext) : plaintext);
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

/**
 * A number column sealed on the client before it enters Jazz; the view type
 * is `number`. Same label semantics as {@link encryptedText}. The stored
 * representation is text, so values beyond the plain integer column's 32-bit
 * range round-trip exactly up to double precision. Non-finite values are
 * rejected at write time.
 */
export function encryptedNumber(label: string): StringColumn<false, false, number> {
  return schema.string().transform({
    to: (value: number) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`encrypted column "${label}" only stores finite numbers`);
      }
      return seal(label, String(value));
    },
    from: (value: string) => {
      const parsed = Number(open(label, value));
      if (!Number.isFinite(parsed)) {
        throw new EncryptedColumnError(
          "corrupt",
          `encrypted column "${label}" opened to a non-numeric payload`,
        );
      }
      return parsed;
    },
  }) as unknown as StringColumn<false, false, number>;
}

/**
 * A date column sealed on the client before it enters Jazz; the view type is
 * `Date`, matching the plain timestamp column. Same label semantics as
 * {@link encryptedText}. Invalid dates are rejected at write time.
 */
export function encryptedDate(label: string): StringColumn<false, false, Date> {
  return schema.string().transform({
    to: (value: Date) => {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new TypeError(`encrypted column "${label}" only stores valid dates`);
      }
      return seal(label, String(value.getTime()));
    },
    from: (value: string) => {
      const epochMs = Number(open(label, value));
      if (!Number.isInteger(epochMs)) {
        throw new EncryptedColumnError(
          "corrupt",
          `encrypted column "${label}" opened to a non-date payload`,
        );
      }
      return new Date(epochMs);
    },
  }) as unknown as StringColumn<false, false, Date>;
}
