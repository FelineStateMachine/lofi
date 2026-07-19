import type { QueryBuilder, TableProxy } from "jazz-tools";
import { syncing } from "../runtime/config.ts";
import { type DurableWrite, settleDurableWrite } from "../runtime/durability.ts";
import { getRuntime, updateRuntimeDiagnostics } from "../runtime/runtime.ts";
import { AccessError } from "./errors.ts";
import {
  bootstrapGroupFieldKey,
  reconcileSharedFieldKeys,
  rotateGroupFieldKey,
  type SharedFieldLifecycleContext,
  wrapHeldKeysForMember,
} from "./shared-field-lifecycle.ts";
import { activeAppId } from "../runtime/config.ts";
import {
  decodeSharingIdentity,
  decodeSharingIdentityDetails,
  type SharingIdentity,
} from "./identity.ts";
import { type GroupRole, groupRoleCapabilities, groupRoles } from "./schema.ts";

/** Minimum row shape accepted by collaboration operations. */
export type Identified = { id: string };
/** Jazz table shape required by the access operation helpers. */
export type AccessRuntimeTable<Row, Init> = TableProxy<Row, Init> & {
  where(input: unknown): QueryBuilder<Row>;
};
/** Conventional direct-share grant row. */
export type SharedGrantRow = Identified & {
  resourceId: string;
  user_id: string;
  can_edit: boolean;
};
/** Conventional fixed-role group membership row. */
export type GroupMembershipRow = Identified & {
  groupId: string;
  user_id: string;
  role: GroupRole;
  can_create: boolean;
  can_edit_any: boolean;
  can_manage: boolean;
};

function requireSync(operation: string): void {
  if (!syncing()) {
    throw new AccessError(
      "sync-required",
      `${operation} requires managed sync and an account that has elected to sync. Private resources remain available local-only.`,
    );
  }
}

// Share and membership writes settle through the shared runtime settlement
// core, so access operations use the same diagnostics accounting as table
// mutations and stay visible to the inspector. Access writes await the global
// tier inline: a share is not "done" until the server accepted it.
async function settle<T>(write: DurableWrite<T>): Promise<T> {
  try {
    const result = await settleDurableWrite(write, updateRuntimeDiagnostics, "await", {
      onGlobal: () =>
        updateRuntimeDiagnostics((diagnostics) => diagnostics.lastWriteDurability = "global"),
    });
    return result;
  } catch (cause) {
    updateRuntimeDiagnostics((diagnostics) => diagnostics.lastWriteDurability = "failed");
    throw new AccessError(
      "mutation-rejected",
      "Jazz rejected the access change. Refresh permissions and membership, then try again.",
      { cause },
    );
  }
}

function assertRole(role: string): asserts role is GroupRole {
  if (!(groupRoles as readonly string[]).includes(role)) {
    throw new AccessError(
      "invalid-role",
      `Unknown group role ${JSON.stringify(role)}; choose reader, contributor, writer, or admin.`,
    );
  }
}

/** Access level assigned by a direct share. */
export type ShareLevel = "read" | "edit";

/** Direct-share operations bound to one resource and grant table pair. */
export type SharingOperations<Resource, Grant> = {
  /**
   * Grants the recipient access at `level`. Upserts: when a grant already
   * exists for that recipient, its level is changed in place — including
   * silently downgrading `edit` to `read`.
   */
  share(resourceId: string, recipient: SharingIdentity | string, level: ShareLevel): Promise<Grant>;
  /** Deletes every grant for the recipient on the resource; no-op when none exist. */
  revoke(resourceId: string, recipient: SharingIdentity | string): Promise<void>;
  /** Lists the current grants on one resource. */
  listShares(resourceId: string): Promise<Grant[]>;
  /** Lists resources other accounts have shared with the current account. */
  sharedWithMe(): Promise<Resource[]>;
};

/** Creates direct-share operations that wait for local and global durability. */
export function createSharingOperations<
  Resource extends Identified,
  ResourceInit,
  Grant extends SharedGrantRow,
  GrantInit,
>(config: {
  resource: AccessRuntimeTable<Resource, ResourceInit>;
  grants: AccessRuntimeTable<Grant, GrantInit>;
}): SharingOperations<Resource, Grant> {
  const findGrant = async (resourceId: string, userId: string): Promise<Grant | null> => {
    const { db } = await getRuntime();
    return await db.one(config.grants.where({ resourceId, user_id: userId } as never));
  };

  return {
    async share(
      resourceId: string,
      recipient: SharingIdentity | string,
      level: ShareLevel,
    ): Promise<Grant> {
      requireSync("Sharing");
      const userId = decodeSharingIdentity(recipient);
      const { db } = await getRuntime();
      const existing = await findGrant(resourceId, userId);
      if (existing) {
        await settle(
          db.update(config.grants, existing.id, { can_edit: level === "edit" } as never),
        );
        return { ...existing, can_edit: level === "edit" };
      }
      const inserted = db.insert(config.grants, {
        resourceId,
        user_id: userId,
        can_edit: level === "edit",
      } as GrantInit);
      return await settle(inserted);
    },

    async revoke(resourceId: string, recipient: SharingIdentity | string): Promise<void> {
      requireSync("Revoking a share");
      const userId = decodeSharingIdentity(recipient);
      const { db } = await getRuntime();
      const rows = await db.all(config.grants.where({ resourceId, user_id: userId } as never));
      await Promise.all(rows.map((row) => settle(db.delete(config.grants, row.id))));
    },

    async listShares(resourceId: string): Promise<Grant[]> {
      requireSync("Listing shares");
      const { db } = await getRuntime();
      return await db.all(config.grants.where({ resourceId } as never));
    },

    async sharedWithMe(): Promise<Resource[]> {
      requireSync("Listing resources shared with you");
      const { db } = await getRuntime();
      const userId = db.getAuthState().session?.user_id;
      if (!userId) {
        throw new AccessError("invalid-identity", "The current Jazz principal is not ready.");
      }
      const grants = await db.all(config.grants.where({ user_id: userId } as never));
      const resources = await Promise.all(
        grants.map((grant) => db.one(config.resource.where({ id: grant.resourceId } as never))),
      );
      const available: Resource[] = [];
      for (const row of resources) if (row !== null) available.push(row as Resource);
      return available;
    },
  };
}

/** Creates fixed-role group membership operations for a declared table pair. */
export function createGroupOperations<
  Group extends Identified,
  GroupInit,
  Member extends GroupMembershipRow,
  MemberInit,
>(config: {
  groups: AccessRuntimeTable<Group, GroupInit>;
  members: AccessRuntimeTable<Member, MemberInit>;
  /** Wrapped-field-key and directory tables, for groups hosting shared
   * encrypted columns; the group lifecycle then mints, wraps, and rotates
   * field keys automatically. */
  fieldKeys?: AccessRuntimeTable<Identified, unknown>;
  directory?: AccessRuntimeTable<Identified, unknown>;
}): GroupOperations<Group, GroupInit, Member> {
  const findMember = async (groupId: string, userId: string): Promise<Member | null> => {
    const { db } = await getRuntime();
    return await db.one(config.members.where({ groupId, user_id: userId } as never));
  };

  // The lifecycle context resolves lazily per call: the runtime, principal,
  // and app id all belong to the moment of the operation.
  const lifecycleContext = async (): Promise<SharedFieldLifecycleContext | null> => {
    if (!config.fieldKeys || !config.directory) return null;
    const { db } = await getRuntime();
    const userId = db.getAuthState().session?.user_id;
    if (!userId) {
      throw new AccessError("invalid-identity", "The current Jazz principal is not ready.");
    }
    const groupTable = (config.groups as unknown as { _table?: string })._table;
    if (!groupTable) {
      throw new AccessError("configuration", "The group table does not expose its name.");
    }
    return {
      db: db as never,
      appId: activeAppId(),
      userId,
      groupTable,
      fieldKeys: config.fieldKeys as never,
      directory: config.directory as never,
      members: config.members as never,
    };
  };

  return {
    async createGroup(values: GroupInit): Promise<{ group: Group; membership: Member }> {
      requireSync("Creating a group");
      const { db } = await getRuntime();
      const userId = db.getAuthState().session?.user_id;
      if (!userId) {
        throw new AccessError("invalid-identity", "The current Jazz principal is not ready.");
      }
      const group = await settle(db.insert(config.groups, values));
      try {
        const membership = await settle(db.insert(config.members, {
          groupId: group.id,
          user_id: userId,
          ...groupRoleCapabilities("admin"),
        } as MemberInit));
        const lifecycle = await lifecycleContext();
        if (lifecycle) await bootstrapGroupFieldKey(lifecycle, group.id);
        return { group, membership };
      } catch (cause) {
        // The creator's direct delete authority on their own group row
        // authorizes this rollback, so a failed first-admin insert no longer
        // strands an undeletable orphan group.
        await settle(db.delete(config.groups, group.id)).catch(() => undefined);
        throw cause;
      }
    },

    async addMember(
      groupId: string,
      recipient: SharingIdentity | string,
      role: GroupRole,
    ): Promise<Member> {
      requireSync("Adding a group member");
      assertRole(role);
      const details = decodeSharingIdentityDetails(recipient);
      const userId = details.userId;
      const existing = await findMember(groupId, userId);
      if (existing) {
        throw new AccessError(
          "mutation-rejected",
          "That account is already a member of this group.",
        );
      }
      const { db } = await getRuntime();
      const membership = await settle(
        db.insert(config.members, {
          groupId,
          user_id: userId,
          ...groupRoleCapabilities(role),
        } as MemberInit),
      );
      // Key delivery is best-effort here: a member without a directory entry
      // sits in the documented pending state until a key-holding device runs
      // reconcileSharedFieldKeys. The membership itself never waits on keys.
      const lifecycle = await lifecycleContext();
      if (lifecycle) {
        await wrapHeldKeysForMember(lifecycle, groupId, userId, details.fingerprint)
          .catch(() => undefined);
      }
      return membership;
    },

    async changeRole(
      groupId: string,
      recipient: SharingIdentity | string,
      role: GroupRole,
    ): Promise<Member> {
      requireSync("Changing a group role");
      assertRole(role);
      const userId = decodeSharingIdentity(recipient);
      const member = await findMember(groupId, userId);
      if (!member) {
        throw new AccessError("not-found", "That account is not a member of this group.");
      }
      const { db } = await getRuntime();
      const capabilities = groupRoleCapabilities(role);
      await settle(db.update(config.members, member.id, capabilities as never));
      return { ...member, ...capabilities };
    },

    async removeMember(groupId: string, recipient: SharingIdentity | string): Promise<void> {
      requireSync("Removing a group member");
      const removedUserId = decodeSharingIdentity(recipient);
      const member = await findMember(groupId, removedUserId);
      if (!member) return;
      const { db } = await getRuntime();
      await settle(db.delete(config.members, member.id));
      // Lazy rekey: future writes seal under a generation the removed member
      // never receives; already-held generations remain readable to them.
      const lifecycle = await lifecycleContext();
      if (lifecycle) {
        await rotateGroupFieldKey(lifecycle, groupId, removedUserId).catch(() => undefined);
      }
    },

    async leaveGroup(groupId: string): Promise<void> {
      requireSync("Leaving a group");
      const { db } = await getRuntime();
      const userId = db.getAuthState().session?.user_id;
      if (!userId) {
        throw new AccessError("invalid-identity", "The current Jazz principal is not ready.");
      }
      const member = await findMember(groupId, userId);
      if (!member) return;
      await settle(db.delete(config.members, member.id));
    },

    async listMembers(groupId: string): Promise<Member[]> {
      requireSync("Listing group members");
      const { db } = await getRuntime();
      return await db.all(config.members.where({ groupId } as never));
    },

    async reconcileSharedFieldKeys(groupId: string): Promise<number> {
      requireSync("Repairing shared-field keys");
      const lifecycle = await lifecycleContext();
      if (!lifecycle) {
        throw new AccessError(
          "configuration",
          "These group operations were created without fieldKeys/directory tables; declare " +
            "them to host shared encrypted columns.",
        );
      }
      return await reconcileSharedFieldKeys(lifecycle, groupId);
    },
  };
}

/** Fixed-role group creation and membership operations. */
export type GroupOperations<Group, GroupInit, Member> = {
  /** Creates the group row and the creator's admin membership. */
  createGroup(values: GroupInit): Promise<{ group: Group; membership: Member }>;
  /**
   * Adds the recipient at `role`; rejects when they are already a member
   * (use {@linkcode GroupOperations.changeRole} instead). For groups hosting
   * shared columns, key delivery is best-effort — a member without a
   * directory entry stays pending until
   * {@linkcode GroupOperations.reconcileSharedFieldKeys} runs.
   */
  addMember(
    groupId: string,
    recipient: SharingIdentity | string,
    role: GroupRole,
  ): Promise<Member>;
  /** Replaces an existing member's role capabilities; rejects for non-members. */
  changeRole(
    groupId: string,
    recipient: SharingIdentity | string,
    role: GroupRole,
  ): Promise<Member>;
  /**
   * Deletes the membership; no-op for non-members. Shared-field keys rotate
   * lazily: future writes seal under a generation the removed member never
   * receives, but content sealed under generations they already hold remains
   * readable to them.
   */
  removeMember(groupId: string, recipient: SharingIdentity | string): Promise<void>;
  /** Deletes the current account's own membership; no-op for non-members. */
  leaveGroup(groupId: string): Promise<void>;
  /** Lists the memberships of one group. */
  listMembers(groupId: string): Promise<Member[]>;
  /** Repairs missing field-key wraps for a group hosting shared columns;
   * throws a configuration error when the operations were created without
   * `fieldKeys`/`directory` tables. Returns the number of wraps inserted. */
  reconcileSharedFieldKeys(groupId: string): Promise<number>;
};
