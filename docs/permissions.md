# Permissions

`src/permissions.ts` is an author-owned security boundary. It defines which signed local-first
identity may read or mutate each table; hiding a button in the UI is not a substitute for policy.

## The starter policy

The generated task app uses creator-owned rows:

```ts
import { schema as s } from "jazz-tools";
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

## Collaboration is not implied

The starter demonstrates private, creator-owned data. It does not generate sharing, invitations,
roles, revocation, or organization membership. Those features require a deliberate Jazz policy and
product flow; do not infer them from the presence of sync.

When adding collaboration, test at least:

- the creator's access;
- an explicitly authorized second identity;
- an unrelated identity;
- access after the product's revoke/remove action;
- offline edits followed by reconnection.
