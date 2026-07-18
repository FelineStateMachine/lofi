# Lofi-owned schema facade over the Jazz 2 DSL

Date: 2026-07-18\
Reviewed dependency: `jazz-tools@2.0.0-alpha.53`\
Decision: adopt a curated one-to-one re-export; reject a translating facade

## Question

The developer-experience contract deferred whether a lofi-owned schema facade is "honest and
affordable" (previously gated on #7). Until now `src/schema.ts` and `src/permissions.ts` were the
two deliberate raw-Jazz surfaces in author source, importing `schema as s` from `jazz-tools`
directly.

## Context and control

The baseline (control) is the M1 arrangement: direct pinned `jazz-tools` imports in author schema
and permission files, with the author-boundary test exempting those two files from its raw-Jazz
rule. Two facts changed the trade-off:

1. Jazz 2 replaced the publicly documented 1.x CoValue API (`co.map`, `co.list`, `co.feed`, CoText,
   FileStream) with a relational table DSL. Public Jazz documentation describes 1.x, so a
   transparent surface delegates authors to documentation that is wrong for the pinned version.
2. Alpha releases change behavior without notice (see
   [group-creator-authority-alpha53](group-creator-authority-alpha53.md)); every schema author was
   exposed to that churn directly.

## Decision

Adopt the **re-export kind** of facade and reject the **translating kind**:

- `@nzip/lofi/schema` exports `s`, a curated `Pick` of the pinned Jazz 2 `schema` namespace. Every
  exposed member is the Jazz original by object identity — verified by test — so names, semantics,
  error messages, and tooling output cannot drift from what runs underneath. The module also
  re-exports the DSL's schema-authoring types (`App`, `Schema`, `InsertOf`, `WhereOf`, and related).
- Curation is by omission only: the deprecated `col.rename` and the unexercised `defineSliceableApp`
  are left out. Nothing is renamed, wrapped, or reinterpreted; a translating facade (a lofi-invented
  schema language) remains rejected as a non-goal.
- Author files declare data exclusively through `@nzip/lofi/schema`. The generated author-boundary
  test now applies the raw-Jazz rule to every author source file with no exemptions. Direct
  `jazz-tools` imports remain possible as an explicitly unsupported escape hatch, per the existing
  escape-hatch row of the contract.

Honest: the facade translates nothing, so it cannot misrepresent the vendor surface. Affordable: it
re-exports rather than reimplements, so its maintenance cost is the curation list and one identity
test.

## Procedure and evidence

- `package/schema/mod.ts` — the facade; `package/schema/mod_test.ts` verifies member identity
  against `jazz-tools` and round-trips `defineApp`/`definePermissions` through the facade.
- `package/schema/merge_sync_test.ts` — concurrent-writer merge semantics (lww, counter, g-set) over
  a real JazzServer with two synced clients and a fresh observer.
- `package/schema/migration_test.ts` — the schema-evolution surface (`defineSchema`,
  `defineMigration`, `renameTableFrom`, `add`/`drop`/`renameFrom`) over a real JazzServer: forward
  and backward lens directions plus the missing-migration deploy guardrail.
- `apps/reference/tests/author-boundary_test.ts` — rejects `jazz-tools` imports in all author
  source, including `schema.ts` and `permissions.ts`.
- `deno task check` and `deno task build` pass with the reference app (and therefore the starter,
  which copies it) migrated to the facade.

## Contract delta

The author-boundary rows for `schema.ts` and `permissions.ts` no longer allow direct pinned Jazz
declarations; both declare through `@nzip/lofi/schema`. The schema safe default changes from "use
the smallest verified Jazz 2 surface" to "expose the pinned DSL through the re-export, never a
second schema language." Version bumps of `jazz-tools` become package releases: upstream renames are
absorbed by the facade instead of breaking application schemas.

## Conformance findings (alpha.53)

The column-type conformance suite (`package/schema/conformance_test.ts`, task
`deno task test:conformance`, part of `deno task check`) exercises every facade column type through
the official policy test harness against the real engine. Verified working end to end: string,
boolean, int (within i32), float, timestamp storage, enum, ref, json, array, bytes (≥32-byte
payloads observed reliable), `.optional()`, `.default()`, `.transform()` (view type on
insert/read/update; `where` filters take the stored type), lww merge (the default; concurrent
conflicts resolve to the last write to reach the server on every replica), counter merge
(single-session), g-set merge (single-table apps, cross-writer union), policy conditions over typed
columns with `anyOf` alternatives, `permissionIntrospectionColumns` (`$canRead`/`$canEdit`/
`$canDelete` selected per row, mirroring the deployed policy), and the full migration surface
(`defineSchema`, `defineMigration`, `renameTableFrom`, `add`/`drop`/`renameFrom`; forward and
backward lens directions carry data correctly, and deploying a changed schema without its migration
reports `status: "missing"` and withholds permissions). The three merge strategies (`lww`,
`counter`, `g-set`) are the complete collaborative-value surface of the pinned alpha — Jazz 2
exports no successor to the 1.x CoValue types. Engine and type bugs found and pinned in the suite so
an alpha bump surfaces any change:

1. **`.merge()` and `.transform()` erase column typing.** The legacy untyped signatures
   (`merge(): this`, `transform(): ColumnBuilder`) shadow the typed overloads, degrading the column
   to `ColumnBuilder` and poisoning the whole table's row types. Runtime unaffected. Workaround
   documented on `@nzip/lofi/schema`: cast the result back (e.g.
   `as unknown as
   IntColumn<false, true>`, `as unknown as StringColumn<false, false, string[]>`).
2. **Int columns are i32 at runtime.** Values outside i32 are rejected with
   `InvalidArg … expected
   i32` despite the `number` static type. Pinned.
3. **Timestamp where-equality matches every row** (verified with distinct non-epoch dates), and
   running that query wedges the FFI driver: the next harness boot in the same process hangs on its
   first write. Pinned; the scalar test deliberately runs last.
4. **A g-set column destabilizes cross-table writes.** In a process that has booted harnesses
   before, writing a sibling table before the g-set table's first write hangs indefinitely
   (reproduced five times in bisection); a fresh process may not reproduce it. Covered by a tolerant
   subprocess canary; g-set coverage stays isolated in a single-table app.
5. **Short byte payloads are unreliable.** A 2-byte insert has been observed succeeding, failing
   with `WriteError … data too short for column value`, and hanging, depending on process context.
   Covered by a tolerant subprocess canary.
6. **Counter merge semantics are inconsistent across replica lifetimes.** Verified with two synced
   clients plus a fresh observer (`package/schema/merge_sync_test.ts`): the server keeps the last
   causally ordered update value and sums only concurrent updates, while live replicas apply every
   update — including the echo of their own reconnected write — as a delta. A replica that watched
   the history diverges permanently from what a fresh boot reads (observed: canonical 8, first
   writer 13 after a concurrent 5/3 conflict on 0; canonical 3, live replicas 5 after causal 2 then
   3). The full matrix is pinned. G-set union merge, by contrast, is verified convergent across
   writers and fresh boots.

Hangs cannot be cancelled through FFI, so the canaries run in child processes that force-exit
(`package/testdata/gset_hang_canary.ts`, `package/testdata/bytes_short_payload_canary.ts`). The
concurrent-writer suite runs before the conformance suite in a separate process because the scalar
test wedges the FFI driver last.

## Follow-up

- Re-verify all pins on each alpha bump and remove the ones upstream fixes; findings 2–6 stay
  internal until our own testing is complete and a report is explicitly decided.
- Merge the g-set table back into the main conformance app when the cross-table hang is gone.
- Revisit the curation list on each alpha bump; `defineSliceableApp` joins the surface when a use
  case and tests exist. — Done: it joined with conformance coverage as the base of nested app
  namespaces; see [nested-namespaces-alpha53](nested-namespaces-alpha53.md).
