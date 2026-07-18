import type { QueryBuilder, TableProxy } from "jazz-tools";
import { syncing } from "../runtime/config.ts";
import { type DurableWrite, settleDurableWrite } from "../runtime/durability.ts";
import { getRuntime, updateRuntimeDiagnostics } from "../runtime/runtime.ts";
import { AccessError } from "./errors.ts";
import { decodeSharingIdentity, type SharingIdentity } from "./identity.ts";
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
  share(resourceId: string, recipient: SharingIdentity | string, level: ShareLevel): Promise<Grant>;
  revoke(resourceId: string, recipient: SharingIdentity | string): Promise<void>;
  listShares(resourceId: string): Promise<Grant[]>;
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
}): GroupOperations<Group, GroupInit, Member> {
  const findMember = async (groupId: string, userId: string): Promise<Member | null> => {
    const { db } = await getRuntime();
    return await db.one(config.members.where({ groupId, user_id: userId } as never));
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
      const userId = decodeSharingIdentity(recipient);
      const existing = await findMember(groupId, userId);
      if (existing) {
        throw new AccessError(
          "mutation-rejected",
          "That account is already a member of this group.",
        );
      }
      const { db } = await getRuntime();
      return await settle(
        db.insert(config.members, {
          groupId,
          user_id: userId,
          ...groupRoleCapabilities(role),
        } as MemberInit),
      );
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
      const member = await findMember(groupId, decodeSharingIdentity(recipient));
      if (!member) return;
      const { db } = await getRuntime();
      await settle(db.delete(config.members, member.id));
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
  };
}

/** Fixed-role group creation and membership operations. */
export type GroupOperations<Group, GroupInit, Member> = {
  createGroup(values: GroupInit): Promise<{ group: Group; membership: Member }>;
  addMember(
    groupId: string,
    recipient: SharingIdentity | string,
    role: GroupRole,
  ): Promise<Member>;
  changeRole(
    groupId: string,
    recipient: SharingIdentity | string,
    role: GroupRole,
  ): Promise<Member>;
  removeMember(groupId: string, recipient: SharingIdentity | string): Promise<void>;
  leaveGroup(groupId: string): Promise<void>;
  listMembers(groupId: string): Promise<Member[]>;
};
