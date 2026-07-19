/**
 * The write side of shared encrypted columns: the mutation layer sees whole
 * rows, so it — not the column transform — resolves each shared column's
 * group scope from the configured sibling column, picks the newest field key
 * this device holds, and seals the value before anything is journaled or
 * handed to the engine. The column transform then only verifies the sealed
 * prefix, so a write that bypasses this path fails closed instead of storing
 * plaintext.
 *
 * @module
 */
import { encryptedColumnsOf } from "../schema/encrypted.ts";
import { sealSharedValue, SharedFieldError } from "../schema/shared-crypto.ts";
import {
  getSharedFieldKey,
  latestSharedFieldGeneration,
  sharedKeyScope,
} from "../schema/shared-keyring.ts";
import { sharedColumnConfig } from "../schema/shared-registry.ts";

const SEALED_PREFIX = "encs1.";

type SharedWrite = {
  column: string;
  label: string;
  kind: "text" | "json";
  group: string;
  groupIdColumn: string;
};

function sharedWritesOf(tableName: string, values: Record<string, unknown>): SharedWrite[] {
  const encrypted = encryptedColumnsOf(tableName);
  if (encrypted === undefined) return [];
  const writes: SharedWrite[] = [];
  for (const [column, label] of encrypted) {
    if (!(column in values)) continue;
    const config = sharedColumnConfig(label);
    if (config === undefined) continue;
    const value = values[column];
    // Already sealed (a replayed journal entry or caller-provided seal).
    if (typeof value === "string" && value.startsWith(SEALED_PREFIX)) continue;
    writes.push({
      column,
      label,
      kind: config.kind,
      group: config.group,
      groupIdColumn: config.groupIdColumn,
    });
  }
  return writes;
}

function sealOne(
  write: SharedWrite,
  groupId: unknown,
  value: unknown,
): string {
  if (typeof groupId !== "string" || !groupId) {
    throw new SharedFieldError(
      "unscoped-write",
      `shared column "${write.label}" needs the row's "${write.groupIdColumn}" to resolve its ` +
        "key scope — include it in the write",
    );
  }
  const scope = sharedKeyScope(write.group, groupId);
  const generation = latestSharedFieldGeneration(scope);
  if (generation === null) {
    throw new SharedFieldError(
      "key-pending",
      `no field key for ${scope} is installed on this device yet — writing waits for the ` +
        "group key to arrive",
    );
  }
  const fieldKey = getSharedFieldKey(scope, generation);
  if (fieldKey === null) {
    throw new SharedFieldError("key-pending", `the field key for ${scope} is not installed`);
  }
  const plaintext = write.kind === "json" ? JSON.stringify(value) : String(value);
  return sealSharedValue({
    plaintext,
    fieldKey,
    label: write.label,
    scope: { groupTable: write.group, groupId, generation },
  });
}

/** Whether a write touches any shared column that still needs sealing. */
export function hasSharedColumnWrites(
  tableName: string,
  values: Record<string, unknown>,
): boolean {
  return sharedWritesOf(tableName, values).length > 0;
}

/**
 * Seals every shared column present in a write, resolving the group id from
 * the values themselves. Throws `unscoped-write` when a shared column is
 * written without its group column — the synchronous path cannot fetch the
 * row; include the group column in the patch or use the async variant.
 */
export function sealSharedColumnValuesSync(
  tableName: string,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const writes = sharedWritesOf(tableName, values);
  if (writes.length === 0) return values;
  const sealed = { ...values };
  for (const write of writes) {
    sealed[write.column] = sealOne(write, values[write.groupIdColumn], values[write.column]);
  }
  return sealed;
}

/**
 * Seals every shared column present in a write, fetching the existing row
 * for updates whose patch omits the group column.
 */
export async function sealSharedColumnValues(
  tableName: string,
  values: Record<string, unknown>,
  fetchRow?: () => Promise<Record<string, unknown> | null>,
): Promise<Record<string, unknown>> {
  const writes = sharedWritesOf(tableName, values);
  if (writes.length === 0) return values;
  const sealed = { ...values };
  let row: Record<string, unknown> | null | undefined;
  for (const write of writes) {
    let groupId = values[write.groupIdColumn];
    if ((typeof groupId !== "string" || !groupId) && fetchRow) {
      row ??= await fetchRow();
      groupId = row?.[write.groupIdColumn];
    }
    sealed[write.column] = sealOne(write, groupId, values[write.column]);
  }
  return sealed;
}
