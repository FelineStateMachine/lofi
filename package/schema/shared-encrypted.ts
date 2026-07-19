/**
 * Shared encrypted columns: fields readable by every member of a group,
 * sealed from the sync server. The stored value is the `encs1.` format from
 * the crypto core — scope and generation ride the string, and the
 * synchronous read transform resolves the field key from the in-memory
 * keyring.
 *
 * Reads are state-valued, never throwing for a missing key: a thrown
 * transform fails the whole query, and key-pending is the normal state of a
 * freshly added member whose wrap has not arrived. The value surfaces as
 * `ready`, `pending-key`, or `corrupt`, and live queries re-materialize when
 * the keyring changes.
 *
 * Writes are sealed by the mutation layer, which sees the whole row and
 * resolves the group scope from the configured sibling column; the column's
 * own write transform only guards — a write that reaches it unsealed throws
 * rather than storing plaintext, so raw engine access fails closed.
 *
 * @module
 */
import { schema } from "jazz-tools";
import { type EncryptedColumn, markEncryptedColumn } from "./encrypted.ts";
import { openSharedValue, parseSharedValue, SharedFieldError } from "./shared-crypto.ts";
import { getSharedFieldKey, sharedKeyScope } from "./shared-keyring.ts";
import { registerSharedColumn, type SharedColumnConfig } from "./shared-registry.ts";

/** The read state of a shared encrypted column. */
export type SharedFieldValue<T> =
  | { state: "ready"; value: T }
  | { state: "pending-key"; scope: string; generation: number }
  | { state: "corrupt"; code: "corrupt" | "unscoped-write" };

/** Options wiring a shared column to its group, keys, and directory tables. */
export type SharedColumnOptions = Omit<SharedColumnConfig, "label">;

/** Whether a shared field value holds decrypted content. */
export function sharedFieldReady<T>(
  value: SharedFieldValue<T>,
): value is { state: "ready"; value: T } {
  return value.state === "ready";
}

/**
 * The decrypted content of a shared field, for callers who prefer an
 * exception over a state check. Throws `key-pending` while the wrap is in
 * flight and `corrupt` for failed authentication.
 */
export function unwrapSharedField<T>(value: SharedFieldValue<T>): T {
  if (value.state === "ready") return value.value;
  if (value.state === "pending-key") {
    throw new SharedFieldError(
      "key-pending",
      `the field key for ${value.scope} generation ${value.generation} has not arrived`,
    );
  }
  throw new SharedFieldError(value.code, "the shared field failed authentication");
}

const SEALED_PREFIX = "encs1.";

function openStored<T>(
  label: string,
  stored: string,
  decode: (plaintext: string) => T,
): SharedFieldValue<T> {
  const parsed = parseSharedValue(stored);
  if (parsed === null) return { state: "corrupt", code: "corrupt" };
  const scope = sharedKeyScope(parsed.scope.groupTable, parsed.scope.groupId);
  const fieldKey = getSharedFieldKey(scope, parsed.scope.generation);
  if (fieldKey === null) {
    return { state: "pending-key", scope, generation: parsed.scope.generation };
  }
  try {
    return { state: "ready", value: decode(openSharedValue({ stored, fieldKey, label })) };
  } catch {
    return { state: "corrupt", code: "corrupt" };
  }
}

function guardedWrite(label: string, value: unknown): string {
  // The mutation layer seals before the engine runs this transform; a value
  // arriving unsealed means the write bypassed the framework. Failing closed
  // here is what guarantees plaintext never reaches the store.
  if (typeof value === "string" && value.startsWith(SEALED_PREFIX)) return value;
  throw new SharedFieldError(
    "unscoped-write",
    `shared column "${label}" only accepts values sealed by the lofi write path — ` +
      "write through the store or a declared verb",
  );
}

function sharedColumn<T>(
  label: string,
  options: SharedColumnOptions,
  decode: (plaintext: string) => T,
): EncryptedColumn<SharedFieldValue<T>> {
  registerSharedColumn({ label, ...options });
  const built = schema.string().transform({
    to: (value: unknown) => guardedWrite(label, value),
    from: (value: string) => openStored(label, value, decode),
  });
  markEncryptedColumn(built, label);
  return built as unknown as EncryptedColumn<SharedFieldValue<T>>;
}

/**
 * A text column sealed under a group field key: every member holding the
 * key reads it; the store operator never does. `label` is the column's
 * cryptographic identity (`"table.column"`), and the options name the group
 * table, the sibling column referencing the group, the wrapped-key table,
 * and the key directory.
 *
 * ```ts
 * docs: s.table({
 *   workspaceId: s.ref("workspaces"),
 *   body: s.sharedEncryptedText("docs.body", {
 *     group: "workspaces",
 *     groupIdColumn: "workspaceId",
 *     keys: "workspaceFieldKeys",
 *     directory: "keyDirectory",
 *   }),
 * }),
 * ```
 */
export function sharedEncryptedText(
  label: string,
  options: SharedColumnOptions,
): EncryptedColumn<SharedFieldValue<string>> {
  return sharedColumn(label, options, (plaintext) => plaintext);
}

/**
 * A JSON-value column sealed under a group field key; the ready state holds
 * the parsed value. Same label and option semantics as
 * {@link sharedEncryptedText}.
 */
export function sharedEncryptedJson<T = unknown>(
  label: string,
  options: SharedColumnOptions,
): EncryptedColumn<SharedFieldValue<T>> {
  return sharedColumn(label, options, (plaintext) => JSON.parse(plaintext) as T);
}
