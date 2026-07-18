# Collaborative list data model

This example models a workspace task list end to end: the tables, the relationships between them,
the column choice for each field, and the policy that scopes the rows. It is the data-modeling
companion to the access-template examples ([Direct sharing](shared.md),
[Fixed-role group](group.md)), which cover who may touch these rows.

## Shape the tables

Declare every table through the schema facade. Three tables carry the whole feature: the group
resource, its membership relation, and the rows the group collaborates on.

```ts
// src/schema.ts
import { s } from "@nzip/lofi/schema";
import { groupMembershipTable } from "@nzip/lofi/access";

export const app = s.defineApp({
  workspaces: s.table({ name: s.string() }),
  workspaceMembers: groupMembershipTable("workspaces"),
  tasks: s.table({
    workspaceId: s.ref("workspaces"),
    title: s.string(),
    status: s.enum("open", "done", "dropped").default("open"),
    note: s.string().optional(),
    createdAt: s.timestamp(),
  }),
});
```

Each column is a deliberate choice from the [column palette](../data-and-ui.md#column-palette):

- **`s.ref("workspaces")`** is the relationship. It is a filterable foreign key — every scoped query
  below narrows on `workspaceId` — and it is also what the group policy joins on.
- **`s.enum(...)`** models the task lifecycle instead of a boolean pair (`archived`, `completed`)
  that could drift into contradictory states. Enum columns filter correctly with `where`, so the
  hook queries `status: "open"` directly.
- **`.default("open")`** keeps the insert call minimal: creating a task states only what the user
  provided.
- **`.optional()`** marks the one genuinely absent-able field. Prefer one optional column over a
  sentinel value like `""` — the read side gets `null` back and can render accordingly.
- **`s.timestamp()`** exists to order, not to filter: `where`-equality on timestamps is pinned
  broken in the current alpha, so it participates in `orderBy` only.

Concurrent edits to the same row resolve with last-write-wins per column — the verified default. If
the model grows a collaborative set (for example, per-task tags), that is `merge("g-set")`, but keep
such a table in a dedicated app for now; the palette section documents the constraint and the cast
workaround.

## Scope the rows

The policy joins tasks to the membership relation through the `workspaceId` reference declared above
— the model and the policy share one source of truth for the relationship:

```ts
// src/permissions.ts
import { defineAccessPolicies, groupAccess } from "@nzip/lofi/access";
import { app } from "./schema.ts";

export default defineAccessPolicies(app, [groupAccess({
  groups: app.workspaces,
  members: app.workspaceMembers,
  resources: app.tasks,
  groupId: "workspaceId",
})]);
```

Readers see authorized rows. Contributors create and edit their own rows. Writers edit any group
row. Admins also manage membership. Revoking membership removes rows from active queries when the
updated authorization reaches the client; a rejected mutation appears through the mutation hook's
`error` state.

## Query the shape you render

The domain hook binds one scoped query per rendered surface and derives every mutation from the
schema types — no stringly-typed field names survive to the UI:

```ts
import { useLiveQuery, useTableMutations } from "@nzip/lofi/preact";
import { app } from "../app.ts";

export function useWorkspaceTasks(workspaceId: string) {
  const tasks = useLiveQuery(
    () =>
      app.schema.tasks
        .where({ workspaceId, status: "open" })
        .orderBy("createdAt", "desc"),
    [workspaceId],
  );
  const members = useLiveQuery(
    () => app.schema.workspaceMembers.where({ groupId: workspaceId }),
    [workspaceId],
  );
  const mutations = useTableMutations(app.schema.tasks);

  return {
    tasks,
    members,
    mutation: {
      pending: mutations.pending,
      durability: mutations.durability,
      error: mutations.error,
    },
    create: (title: string) => mutations.insert({ workspaceId, title, createdAt: new Date() }),
    rename: (id: string, title: string) => mutations.update(id, { title }),
    complete: (id: string) => mutations.update(id, { status: "done" }),
    drop: (id: string) => mutations.update(id, { status: "dropped" }),
  };
}
```

Note what the schema bought here: `create` passes neither `status` (defaulted) nor `note`
(optional), the `status` transitions are typo-checked against the enum, and completed tasks leave
the list because the query filters on `status`, not because the UI hides them.

## UI

```tsx
export function TaskList({ workspaceId }: { workspaceId: string }) {
  const model = useWorkspaceTasks(workspaceId);
  if (model.tasks.status === "loading") return <p>Loading tasks…</p>;
  if (model.tasks.status === "error") return <p role="alert">{model.tasks.error}</p>;
  return (
    <section>
      <p>{model.tasks.rows.length} open tasks · {model.mutation.durability}</p>
      {model.mutation.error && <p role="alert">{model.mutation.error}</p>}
      <ul>
        {model.tasks.rows.map((task) => <li key={task.id}>{task.title}</li>)}
      </ul>
    </section>
  );
}
```

The same composition works for direct sharing: swap the group tables for a resource table plus its
grant table, and the policy — not the hook — keeps filtering each identity's rows.

Test at least two isolated identities: authorized insert/update/delete visibility, membership or
grant revocation, rejected post-revocation mutations, local durability while offline, and
convergence after reconnect. Use Lofi's two-client fixture for browser behavior and the official
Jazz policy harness for deterministic permission transitions.
