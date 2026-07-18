# Schema evolution

A deployed schema changes with a migration: a bidirectional lens between two schema versions. Rows
written under the old schema read correctly through the new one, and — because the backward
direction is generated automatically — clients still on the old schema keep reading rows written
under the new one. The whole surface below is verified against a real server in
`package/schema/migration_test.ts`.

## Two versions of the schema

The migration names both versions explicitly, so keep the outgoing version around as a value:

```ts
import { s } from "@nzip/lofi/schema";

const v1 = s.defineSchema({
  todos: s.table({ title: s.string(), done: s.boolean(), detail: s.string() }),
  projects: s.table({ name: s.string() }),
});

const v2 = s.defineSchema({
  todos: s.table({
    title: s.string(),
    note: s.string(),
    priority: s.enum("low", "medium", "high"),
  }),
  workspaces: s.table({ name: s.string() }),
});

export const app = s.defineApp(v2);
```

## Describe the change, both directions come free

```ts
export const migration = s.defineMigration({
  from: v1,
  to: v2,
  renameTables: { workspaces: s.renameTableFrom("projects") },
  migrate: {
    todos: {
      priority: s.add.enum("low", "medium", "high", { default: "medium" }),
      note: s.renameFrom("detail"),
      done: s.drop.boolean({ backwardsDefault: false }),
    },
  },
});
```

Every added or removed table and column must be covered — `renameTables`/`createTables`/
`dropTables` at the table level, `s.add.*`, `s.drop.*`, and `s.renameFrom` at the column level — and
the definition fails to type-check until it is. `s.add.*` requires a `default` (what old rows show
under the new schema); `s.drop.*` requires a `backwardsDefault` (what old clients see on rows
written without the column).

Verified behavior across the deployment:

- A v1 row reads under v2 with `note` carrying the old `detail` value, `priority` defaulted to
  `"medium"`, no `done`, and `projects` rows answering under `workspaces`.
- A v2-written row reads under v1 handles with the rename reversed and `done: false` from the
  backwards default; the v2-only `priority` column does not leak.
- Deploying a changed schema **without** its migration publishes nothing usable: the deploy reports
  `migration: { status: "missing" }` and withholds the permissions, so clients never see a schema
  they cannot read data through.

## Day to day

Use `deno task schema:validate` while editing. For a deployed app, generate the migration stub with
`deno task migrations:create`, fill in the ops as above, review it, then publish with
`migrations:push` and `schema:deploy` under the intended managed configuration.
