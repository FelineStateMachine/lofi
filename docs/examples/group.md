# Group-owned resource example

Define a group, its membership relation, and resources that reference it:

```ts
import { schema as s } from "jazz-tools";
import { groupMembershipTable } from "@nzip/lofi/access";

export const app = s.defineApp({
  workspaces: s.table({ name: s.string() }),
  workspaceMembers: groupMembershipTable("workspaces"),
  documents: s.table({ workspaceId: s.ref("workspaces"), title: s.string() }),
});
```

```ts
import { defineAccessPolicies, groupAccess } from "@nzip/lofi/access";
import { app } from "./schema.ts";

export default defineAccessPolicies(app, [groupAccess({
  groups: app.workspaces,
  members: app.workspaceMembers,
  resources: app.documents,
  groupId: "workspaceId",
})]);
```

```ts
import { createGroupOperations } from "@nzip/lofi/access";
import { app } from "./schema.ts";

const groups = createGroupOperations({
  groups: app.workspaces,
  members: app.workspaceMembers,
});
const { group } = await groups.createGroup({ name: "Release team" });
await groups.addMember(group.id, recipientIdentity, "contributor");
await groups.changeRole(group.id, recipientIdentity, "writer");
await groups.removeMember(group.id, recipientIdentity);
```

Readers can read. Contributors can create and edit their own rows. Writers can edit any group row.
Admins can do everything writers can and manage membership. `leaveGroup` removes the current
principal's membership. Managed sync is required for every group operation. The group's creator
additionally keeps a permanent superseat: demoting or removing them does not end their ability to
manage the group — see [Permission templates](../permissions.md#fixed-group-roles) before building
handover flows.
