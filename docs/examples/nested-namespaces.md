# Nested app namespaces

One project often carries more than one app-shaped thing — a task tracker and a notes surface, say —
that should still share one Jazz store, one identity, and one durability story. `s.defineNestedApp`
groups tables into app-level namespaces over a single compiled schema: one schema hash, one
migration lineage, one query planner.

## Declare namespaces

```ts
// src/schema.ts
import { s } from "@nzip/lofi/schema";

export const root = s.defineNestedApp({
  taskapp: {
    projects: s.table({ name: s.string() }),
    tasks: s.table({
      projectId: s.ref("projects"),
      text: s.string(),
      completed: s.boolean(),
    }),
  },
  notesapp: {
    notes: s.table({ title: s.string() }),
  },
});
```

`root.taskapp.tasks` and `root.notesapp.notes` are ordinary typed table handles — queries, inserts,
and live stores treat them exactly like `s.defineApp` tables. Under the hood each nested table
flattens to a global name with the reserved `__` separator (`taskapp__tasks`), so namespace and
table names must not contain `__` or `.`.

Handles are constructed once, inside `defineNestedApp`. The runtime keys table stores by handle
identity, so this is the only expressible construction shape and duplicate subscriptions cannot
arise — keep the declaration at module scope as with any lofi schema.

Refs written against namespace-local names (`s.ref("projects")` above) resolve within the namespace.
To reference a table in another namespace, qualify it:

```ts
attachment: s.ref("taskapp.tasks").optional(),
```

## Permissions per namespace

Each namespace gets its own permissions module. `s.defineNestedPermissions` exposes only that
namespace's tables, under their local names; the compiled output is keyed by the global (mangled)
table names, so per-namespace bundles merge collision-free:

```ts
// src/permissions.ts
import { s } from "@nzip/lofi/schema";
import { root } from "./schema.ts";

const taskPermissions = s.defineNestedPermissions(root.taskapp, ({ policy, session }) => {
  policy.tasks.allowInsert.always();
  policy.tasks.allowRead.where({ $createdBy: session.user_id });
  policy.projects.allowInsert.always();
  policy.projects.allowRead.always();
});

const notePermissions = s.defineNestedPermissions(root.notesapp, ({ policy, session }) => {
  policy.notes.allowInsert.always();
  policy.notes.allowRead.where({ $createdBy: session.user_id });
});

export default s.mergeNestedPermissions(taskPermissions, notePermissions);
```

Use `s.defineNestedPermissions` — not `s.definePermissions` — on a namespace: the pinned
`definePermissions` keys its compiled rules by the object's property names, so calling it on a
namespace directly would compile unprefixed table names the deployed schema does not contain.

## Register the app

The nested root is the schema value of the one lofi app; the runtime consumes its flattened table
registry, so every nested table participates in boot readiness and local-to-managed row migration:

```ts
// src/app.ts
import { defineLofiApp } from "@nzip/lofi";
import { root } from "./schema.ts";

export const app = defineLofiApp({
  name: "my-suite",
  databaseName: "my-suite",
  schema: root,
  storage: "durable",
  sync: { adapter: "jazz" },
});
```

## Migrations across namespaces

Underneath it is still one schema, so the migration surface is unchanged. Author migrations over the
flattened definition (`s.flattenNestedSchema`), and moving a table between namespaces is an ordinary
`renameTableFrom`:

```ts
const migration = s.defineMigration({
  from: s.defineSchema(s.flattenNestedSchema(v1)),
  to: s.defineSchema(s.flattenNestedSchema(v2)),
  renameTables: { notesapp__archive: s.renameTableFrom("taskapp__archive") },
  migrate: {},
});
```

## Known constraint: g-set columns

The conformance findings pin an alpha.53 engine issue where a `g-set` column destabilizes writes to
sibling tables in the same app (see
[the facade decision record](../decisions/schema-facade-alpha53.md)). The standing guidance is to
keep a g-set table in its own single-table app — and under a nested app every table is a runtime
sibling of every namespace, so that isolation cannot be satisfied inside one store. Keep g-set
columns out of nested apps until the upstream pin clears.
