# Collaborative list recipe

This recipe composes ordinary typed queries and mutations with the existing Group policy. There is
no realtime permission mode and no group-specific query hook.

## Schema

```ts
import { schema as s } from "jazz-tools";
import { groupMembershipTable } from "@nzip/lofi/access";

export const app = s.defineApp({
  workspaces: s.table({ name: s.string() }),
  workspaceMembers: groupMembershipTable("workspaces"),
  records: s.table({
    workspaceId: s.ref("workspaces"),
    title: s.string(),
    archived: s.boolean(),
    createdAt: s.timestamp(),
  }),
});
```

## Access policy

```ts
import { defineAccessPolicies, groupAccess } from "@nzip/lofi/access";
import { app } from "./schema.ts";

export default defineAccessPolicies(app, [groupAccess({
  groups: app.workspaces,
  members: app.workspaceMembers,
  resources: app.records,
  groupId: "workspaceId",
})]);
```

Readers see authorized rows. Contributors create and edit their own rows. Writers edit any group
row. Admins also manage membership. Revoking membership removes rows from active queries when the
updated authorization reaches the client; a rejected mutation appears through the mutation hook's
`error` state.

## Scoped resources and membership

```ts
import { useLiveQuery, useTableMutations } from "@nzip/lofi/preact";
import { app } from "../app.ts";

export function useWorkspaceRecords(workspaceId: string) {
  const records = useLiveQuery(
    () =>
      app.schema.records
        .where({ workspaceId, archived: false })
        .orderBy("createdAt", "desc"),
    [workspaceId],
  );
  const members = useLiveQuery(
    () => app.schema.workspaceMembers.where({ groupId: workspaceId }),
    [workspaceId],
  );
  const mutations = useTableMutations(app.schema.records);

  return {
    records,
    members,
    mutation: {
      pending: mutations.pending,
      durability: mutations.durability,
      error: mutations.error,
    },
    create: (title: string) =>
      mutations.insert({
        workspaceId,
        title,
        archived: false,
        createdAt: new Date(),
      }),
    rename: (id: string, title: string) => mutations.update(id, { title }),
    archive: (id: string) => mutations.update(id, { archived: true }),
    remove: mutations.remove,
  };
}
```

The same composition works for direct sharing. Query the resource table for the collaborative list,
query the conventional grant table for grant-management UI, and use `createSharingOperations` for
share/revoke actions. Access policy—not the hook—filters each identity's rows.

## UI

```tsx
export function RecordList({ workspaceId }: { workspaceId: string }) {
  const model = useWorkspaceRecords(workspaceId);
  if (model.records.status === "loading") return <p>Loading records…</p>;
  if (model.records.status === "error") return <p role="alert">{model.records.error}</p>;
  return (
    <section>
      <p>{model.records.rows.length} records · {model.mutation.durability}</p>
      {model.mutation.error && <p role="alert">{model.mutation.error}</p>}
      <ul>
        {model.records.rows.map((record) => <li key={record.id}>{record.title}</li>)}
      </ul>
    </section>
  );
}
```

Test at least two isolated identities: authorized insert/update/delete visibility, membership or
grant revocation, rejected post-revocation mutations, local durability while offline, and
convergence after reconnect. Use Lofi's two-client fixture for browser behavior and the official
Jazz policy harness for deterministic permission transitions.
