# Permissions

`src/permissions.ts` is an author-owned security boundary. It defines which signed local-first
identity may read or mutate each table; hiding a button in the UI is not a substitute for policy.

> Permissions bound which identities may read or write; they do not hide data from the server that
> enforces them. See [the threat model](threat-model.md) for what the server can see and
> [encrypted columns](data-and-ui.md#encrypted-columns) for content it cannot.

## The starter policy

The generated task app uses creator-owned rows:

```ts
import { s } from "@nzip/lofi/schema";
import { app } from "./schema.ts";

export default s.definePermissions(app, ({ policy, session }) => {
  policy.tasks.allowInsert.always();
  policy.tasks.allowRead.where({ $createdBy: session.user_id });
  policy.tasks.allowUpdate.where({ $createdBy: session.user_id });
  policy.tasks.allowDelete.where({ $createdBy: session.user_id });
});
```

This means:

- Any valid app session may create a task.
- A task is readable only by the identity that created it.
- Only that creator may update or delete it.
- Recovering the same identity restores the same authority; opening a new local account does not.

## Adding a table

Add all four decisions deliberately for each new table:

1. Who may insert?
2. Who may read a row?
3. Who may update it?
4. Who may delete it?

Start with creator ownership unless the product has a concrete collaboration model. Do not make a
table broadly readable merely to get a UI prototype working.

## Changing an existing policy

Treat a permission change like a data migration:

1. Describe the intended actors and operations in plain language.
2. Update `src/permissions.ts`.
3. Run `deno task schema:validate`.
4. Run the application tests with at least one allowed and one rejected identity case.
5. Deploy the schema/permission bundle explicitly with `deno task schema:deploy`.

Managed sync configuration is required to publish schema and permission changes. Local-only mode is
still useful for UI work, but it does not prove a cloud permission policy was deployed correctly.

## Choose one narrow access template

The starter remains private by default. When a resource has a concrete collaboration model,
`@nzip/lofi/access` compiles three narrow templates through Jazz's own policy builder:

| Template        | Who can read                     | Who can mutate                                      | Sync     |
| --------------- | -------------------------------- | --------------------------------------------------- | -------- |
| `privateAccess` | Row creator                      | Row creator                                         | Optional |
| `sharedAccess`  | Creator plus explicit recipients | Creator; recipients with editable grants may update | Required |
| `groupAccess`   | Group members                    | Determined by the fixed group role                  | Required |

The schema stays on the lofi schema surface:

```ts
import { s } from "@nzip/lofi/schema";
import { groupMembershipTable, sharedGrantTable } from "@nzip/lofi/access";

const schema = {
  notes: s.table({ title: s.string() }),
  noteGrants: sharedGrantTable("notes"),
  workspaces: s.table({ name: s.string() }),
  workspaceMembers: groupMembershipTable("workspaces"),
  documents: s.table({ workspaceId: s.ref("workspaces"), title: s.string() }),
};
export const app = s.defineApp(schema);
```

Then compose policies:

```ts
export default defineAccessPolicies(app, [
  sharedAccess({ resource: app.notes, grants: app.noteGrants }),
  groupAccess({
    groups: app.workspaces,
    members: app.workspaceMembers,
    resources: app.documents,
    groupId: "workspaceId",
  }),
]);
```

The templates do not replace the schema surface. Use `s.table()`, `s.defineApp()`, and
`s.definePermissions()` directly whenever they do not fit. `defineAccessPolicies` also accepts a
final raw-policy callback for a small extension without hiding the underlying policy builder.

## Fixed group roles

| Role          | Read | Create | Edit own | Edit any | Manage members |
| ------------- | ---- | ------ | -------- | -------- | -------------- |
| `reader`      | yes  | no     | no       | no       | no             |
| `contributor` | yes  | yes    | yes      | no       | no             |
| `writer`      | yes  | yes    | yes      | yes      | no             |
| `admin`       | yes  | yes    | yes      | yes      | yes            |

The helper stores the role label plus fixed capability bits because the pinned Jazz alpha rejects
role-string comparisons inside relationship policies. Only the four role names are accepted by the
typed operations; custom roles belong in a raw policy callback.

**The group creator holds a permanent superseat.** Whoever created the group row can always update
it and — because membership management derives from group-update authority — can always restore
their own admin membership, even after other admins demote or remove them. This is a documented
property of the template, not revocable admin membership: the pinned Jazz alpha cannot express
"creator authority only until the first admin exists" (its policy engine drops negated existence
conditions), so do not present creator handover as complete in product UI. The creator can also
delete their own group rows, which is what lets group creation roll back cleanly if bootstrapping
the first admin membership fails. See
[the decision record](decisions/group-creator-authority-alpha53.md).

Direct shares and group membership use a non-secret `lofi1:<app-id>:<jazz-user-id>` sharing
identity. It is safe to copy for this purpose but is not a directory, invitation, or sign-in token.
The package deliberately does not discover users or deliver invitations.

See the focused [Shared](examples/shared.md) and [Group](examples/group.md) examples and the
[access API reference](reference/access.md).

When adding collaboration, test at least:

- the creator's access;
- an explicitly authorized second identity;
- an unrelated identity;
- access after the product's revoke/remove action;
- offline edits followed by reconnection.
