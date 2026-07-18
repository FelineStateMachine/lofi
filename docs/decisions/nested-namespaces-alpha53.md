# Nested app namespaces over one sliceable schema

Date: 2026-07-18\
Reviewed dependency: `jazz-tools@2.0.0-alpha.53`\
Decision: adopt `defineSliceableApp` into the facade with conformance coverage; adopt a lofi-owned
nested-namespace naming layer on top (issue #107, part 1)

## Question

Can one Jazz store host multiple app-level table namespaces (`taskapp.tasks` alongside
`notesapp.notes`) without a second schema, hash, or migration lineage — and can the schema facade
expose that shape without becoming the translating facade the
[facade decision](schema-facade-alpha53.md) rejects?

## Context and control

The control is the facade baseline: `s.defineApp` produces a single flat table namespace, and
`defineSliceableApp` was curated out as unexercised, with the recorded follow-up that it "joins the
surface when a use case and tests exist." The pinned alpha already ships the core primitive: one
compiled schema, typed sub-app views via `.slice(...)`. Slices select tables but do not rename them,
so nesting has to be a naming layer above the DSL, not a DSL change.

## Decision

- **`defineSliceableApp` joins the curated re-export.** The use case exists (nested namespaces build
  on it) and `package/schema/sliceable_test.ts` is the conformance coverage: slice-derived handles
  query the real engine through the one shared store, per-slice permissions compile and merge into
  one deployable bundle, and the migration surface works over a sliced schema. Facade member
  identity is unchanged — the member is the Jazz original.
- **A lofi-owned naming layer, clearly marked as such.** `s.defineNestedApp` flattens
  `taskapp.tasks` to the global name `taskapp__tasks` (the separator is reserved; it is not `.`
  because the permission builder reserves `${string}.${string}` keys for qualified-column `where`
  entries), compiles one schema through `defineSliceableApp`, and returns per-namespace apps with
  unprefixed typed handles. Handles are constructed exactly once, inside the call — the runtime keys
  table stores by handle identity, so the single-construction shape is the only expressible one. Ref
  targets written against namespace-local names (or `"<namespace>.<table>"` across namespaces) are
  rewritten to the mangled global names by cloning the column builders; the author's definition
  objects are never mutated.
- **Per-namespace permissions via `s.defineNestedPermissions`.** The pinned `definePermissions` keys
  compiled rules by the app object's property names and resolves foreign keys by real schema table
  names, so it cannot be handed a namespace with unprefixed keys without compiling table names the
  deployed schema does not contain. The lofi wrapper passes the mangled-key slice underneath and
  remaps only the policy context to local names: the policy context exposes exactly that namespace's
  tables, while compiled bundles stay keyed by the mangled global names and merge collision-free
  through `s.mergeNestedPermissions` (duplicates throw).
- **The runtime consumes a flattened table registry.** `runtimeTables()` previously walked
  `Object.values(schema)` one level deep, which would silently skip tables inside namespace objects
  during boot readiness and local→managed row migration. A nested root carries its flattened handle
  registry (the same handle objects the namespaces expose, so store identity is preserved); flat
  `defineApp` schemas keep the one-level walk.
- **Migrations are authored over the flattened schema.** `s.flattenNestedSchema` exposes the global
  definition; moving a table between namespaces is an ordinary `renameTableFrom` migration,
  conformance-verified.

The nested members (`defineNestedApp`, `defineNestedPermissions`, `mergeNestedPermissions`,
`flattenNestedSchema`) are the one deliberate exception to the re-export rule: lofi-owned names for
a lofi-owned feature, pinned by test to be lofi's functions and to collide with no Jazz member. They
rename tables (the mangling); they do not reinterpret any Jazz semantics, so the translating facade
remains rejected.

## Procedure and evidence

- `package/schema/nested.ts` — the naming layer; `package/schema/nested_test.ts` — mangling,
  validation, ref rewriting, registry, and permissions-surface unit coverage.
- `package/schema/sliceable_test.ts` — `defineSliceableApp` conformance over the real engine (slice
  queries, merged per-slice permissions, migration over a sliced schema).
- `package/schema/nested_conformance_test.ts` — nested handles, per-namespace policy isolation,
  rewritten refs as working foreign keys, and the namespace-move migration over a real JazzServer.
- `package/runtime/runtime.ts` — `runtimeTables()` consumes the flattened registry.
- `deno task check` passes with the new suites wired into `test:unit` and `test:conformance`.

## Contract delta

The schema surface gains the nested-namespace members and `defineSliceableApp`; the facade promise
("expose the pinned DSL through the re-export, never a second schema language") is unchanged for
every Jazz member. Namespace and table names must not contain `__` or `.`.

## Follow-up

- G-set columns stay out of nested apps: under one store every table is a runtime sibling of every
  namespace, so the g-set isolation guidance (own single-table app) cannot be satisfied inside a
  nested app until the alpha.53 cross-table destabilization pin clears
  ([conformance findings](schema-facade-alpha53.md#conformance-findings-alpha53), finding 4).
  Documented in the [nested-namespaces example](../examples/nested-namespaces.md).
- Issue #107 parts 2 and 3 (runtime-declared sync location; recovery envelope carrying the sink)
  build on this layer and land separately.
- The ref-target rewrite clones builders via their internal `_targetTable`/`_element` fields;
  re-verify the shape on each alpha bump alongside the other pins.
