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
 * - Filters and policies address the stored representation, which is
 *   ciphertext, so both are rejected: a `where` on an encrypted column is a
 *   compile error ({@link EncryptedColumn} collapses the filter position to
 *   `never`), and a permission policy referencing one fails configuration —
 *   the server cannot evaluate what it cannot read. Filter decrypted rows
 *   client-side with {@link matchDecrypted}.
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
import { schema, type TypedColumnBuilder } from "jazz-tools";
import { padPayload, unpadPayload } from "./padding.ts";

declare const encryptedColumnBrand: unique symbol;

/**
 * The phantom stored SQL type of encrypted columns. The union is deliberate:
 * the engine's where-input mapping branches on a single stored sql type, so a
 * union matches no branch and every filter position for the column collapses
 * to `never`. Row and insert types read the view type and are unaffected.
 */
export type EncryptedStoredSql = "TEXT" | "BYTEA";

/**
 * The column type of every `s.encrypted*` constructor. Structurally a valid
 * table column with the declared view type, but excluded from `where` filters
 * at compile time — the store holds ciphertext, so a filter could only ever
 * compare sealed bytes. The chaining modifiers are disabled: a `.default()`
 * would be applied below the seal boundary as plaintext, `.merge()` semantics
 * other than last-write-wins cannot operate on ciphertext, `.transform()`
 * would replace the seal itself, and `.optional()` stays disabled until the
 * engine's null handling of transformed columns is pinned.
 */
export interface EncryptedColumn<TView> extends
  Omit<
    TypedColumnBuilder<EncryptedStoredSql, false, undefined, false, TView>,
    "default" | "merge" | "transform" | "optional"
  > {
  readonly [encryptedColumnBrand]?: TView;
  default(value: never): never;
  merge(strategy: never): never;
  transform(transform: never): never;
  // The `this: never` parameter keeps the method arity-compatible with the
  // base builder while making every call site a compile error.
  optional(this: never): never;
}

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

// Runtime identity of encrypted columns: the factory tags each builder with
// its label, and the schema facade's define wrappers harvest the tags into a
// table/column registry that the access layer consults — the built schema
// types encrypted columns as ordinary TEXT, so the builders are the only
// place the distinction exists.
const ENCRYPTED_LABEL = Symbol("lofi.encryptedColumnLabel");

const registry = new Map<string, Map<string, string>>();
const labelLocations = new Map<string, string>();

/** The encrypted-column label carried by a builder, if it has one. */
export function encryptedColumnLabelOf(builder: unknown): string | undefined {
  if (typeof builder !== "object" || builder === null) return undefined;
  return (builder as { [ENCRYPTED_LABEL]?: string })[ENCRYPTED_LABEL];
}

type TableDefinitionLike = {
  __jazzTableDefinition?: boolean;
  columns?: Record<string, unknown>;
};

function tableColumnsOf(definition: unknown): Record<string, unknown> {
  const like = definition as TableDefinitionLike;
  if (like && typeof like === "object" && like.__jazzTableDefinition === true && like.columns) {
    return like.columns;
  }
  return (definition ?? {}) as Record<string, unknown>;
}

/**
 * Records every encrypted column of a schema definition under its table and
 * column name. The schema facade's `defineSchema`/`defineApp` wrappers call
 * this; it is idempotent for a stable definition. A label reused by a second
 * column is reported: two columns sharing a label share a subkey and their
 * ciphertext replays across them.
 */
export function registerEncryptedColumns(definition: unknown): void {
  if (typeof definition !== "object" || definition === null) return;
  for (const [tableName, tableDefinition] of Object.entries(definition)) {
    for (const [columnName, builder] of Object.entries(tableColumnsOf(tableDefinition))) {
      const label = encryptedColumnLabelOf(builder);
      if (label === undefined) continue;
      const location = `${tableName}.${columnName}`;
      const existing = labelLocations.get(label);
      if (existing !== undefined && existing !== location) {
        console.warn(
          `lofi schema: encrypted-column label "${label}" is used by both ${existing} and ` +
            `${location}; shared labels share a subkey, so their ciphertext replays across ` +
            "the two columns — give each column a unique label",
        );
      }
      labelLocations.set(label, location);
      let table = registry.get(tableName);
      if (table === undefined) {
        table = new Map();
        registry.set(tableName, table);
      }
      table.set(columnName, label);
    }
  }
}

/** Whether the named column of the named table is an encrypted column. */
export function isEncryptedColumn(tableName: string, columnName: string): boolean {
  return registry.get(tableName)?.has(columnName) ?? false;
}

/** The registered encrypted columns of a table, keyed by column name. */
export function encryptedColumnsOf(tableName: string): ReadonlyMap<string, string> | undefined {
  return registry.get(tableName);
}

/** Empties the encrypted-column registry; tests call this between schemas. */
export function clearEncryptedColumnRegistry(): void {
  registry.clear();
  labelLocations.clear();
}

/**
 * Filters live-query rows on decrypted values, client-side. Encrypted columns
 * cannot appear in `where` — the store holds ciphertext — but rows reaching
 * the caller are already decrypted, so arbitrary predicates run locally:
 * narrow the query with plaintext filters first, then match here, and only
 * then apply any limit (a `limit()` before the predicate under-fetches).
 * Sorting on an encrypted column is the same pattern: sort the returned rows,
 * never `orderBy` the column (ciphertext order is arbitrary).
 */
export function matchDecrypted<T>(rows: readonly T[], predicate: (row: T) => boolean): T[] {
  return rows.filter(predicate);
}

/**
 * Tags a live builder as an encrypted column so the registry harvest — and
 * through it the access layer's policy guard — treats it as sealed. The
 * shared-column factories tag their builders with this too.
 */
export function markEncryptedColumn<T extends object>(builder: T, label: string): T {
  Object.defineProperty(builder, ENCRYPTED_LABEL, { value: label });
  return builder;
}

function sealedColumn<TView>(
  label: string,
  transform: { to(value: TView): string; from(value: string): TView },
): EncryptedColumn<TView> {
  const built = schema.string().transform(transform);
  markEncryptedColumn(built, label);
  return built as unknown as EncryptedColumn<TView>;
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
export function encryptedText(label: string): EncryptedColumn<string> {
  return sealedColumn(label, {
    to: (value: string) => seal(label, value),
    from: (value: string) => open(label, value),
  });
}

/**
 * A JSON-value column sealed on the client before it enters Jazz; the view
 * type is the parsed value. Same label semantics as {@link encryptedText}.
 */
export function encryptedJson<T = unknown>(label: string): EncryptedColumn<T> {
  return sealedColumn(label, {
    to: (value: T) => seal(label, JSON.stringify(value)),
    from: (value: string) => JSON.parse(open(label, value)) as T,
  });
}

/**
 * A number column sealed on the client before it enters Jazz; the view type
 * is `number`. Same label semantics as {@link encryptedText}. The stored
 * representation is text, so values beyond the plain integer column's 32-bit
 * range round-trip exactly up to double precision. Non-finite values are
 * rejected at write time.
 */
export function encryptedNumber(label: string): EncryptedColumn<number> {
  return sealedColumn(label, {
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
  });
}

/**
 * A date column sealed on the client before it enters Jazz; the view type is
 * `Date`, matching the plain timestamp column. Same label semantics as
 * {@link encryptedText}. Invalid dates are rejected at write time.
 */
export function encryptedDate(label: string): EncryptedColumn<Date> {
  return sealedColumn(label, {
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
  });
}
