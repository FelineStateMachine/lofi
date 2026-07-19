import { schema as s } from "jazz-tools";
import type { BooleanColumn, DefinedTable, RefColumn, StringColumn } from "jazz-tools";

function requireTableName(name: string, helper: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(
      `${helper} requires a declared Jazz table name, received ${JSON.stringify(name)}`,
    );
  }
}

/** Creates the conventional relationship table used by `sharedAccess`. */
export function sharedGrantTable<const Resource extends string>(
  resource: Resource,
): DefinedTable<{
  resourceId: RefColumn<Resource>;
  user_id: StringColumn;
  can_edit: BooleanColumn;
}> {
  requireTableName(resource, "sharedGrantTable");
  return s.table({
    resourceId: s.ref(resource),
    user_id: s.string(),
    can_edit: s.boolean(),
  });
}

/** Fixed Wave 2 group roles. Custom role systems remain a raw Jazz escape hatch. */
export const groupRoles = ["reader", "contributor", "writer", "admin"] as const;
/** Fixed group roles supported by the built-in group policy template. */
export type GroupRole = (typeof groupRoles)[number];

/** Returns the persisted capability flags for a fixed group role. */
export function groupRoleCapabilities(role: GroupRole): {
  readonly role: GroupRole;
  readonly can_create: boolean;
  readonly can_edit_any: boolean;
  readonly can_manage: boolean;
} {
  return {
    role,
    can_create: role !== "reader",
    can_edit_any: role === "writer" || role === "admin",
    can_manage: role === "admin",
  } as const;
}

/** Creates the conventional relationship table used by `groupAccess`. */
export function groupMembershipTable<const Group extends string>(
  group: Group,
): DefinedTable<{
  groupId: RefColumn<Group>;
  user_id: StringColumn;
  role: StringColumn;
  can_create: BooleanColumn;
  can_edit_any: BooleanColumn;
  can_manage: BooleanColumn;
}> {
  requireTableName(group, "groupMembershipTable");
  return s.table({
    groupId: s.ref(group),
    user_id: s.string(),
    role: s.string(),
    can_create: s.boolean(),
    can_edit_any: s.boolean(),
    can_manage: s.boolean(),
  });
}

/**
 * Creates the shared-field key directory table: one row per account holding
 * its self-published x25519 public key. Declared once per app schema and
 * given to `sharedFieldAccess`, which compiles the policy that makes it
 * world-readable in the store with self-only writes. Public keys are public;
 * integrity comes from fingerprint pinning, not from hiding the rows.
 */
export function sharedFieldDirectoryTable(): DefinedTable<{
  user_id: StringColumn;
  algo: StringColumn;
  public_key: StringColumn;
  fingerprint: StringColumn;
}> {
  return s.table({
    user_id: s.string(),
    algo: s.string(),
    public_key: s.string(),
    fingerprint: s.string(),
  });
}
