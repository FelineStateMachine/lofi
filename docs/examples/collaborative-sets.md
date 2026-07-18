# Collaborative sets

A g-set column is the right shape when several people add elements to the same collection and
nobody's contribution may be lost: concurrent writers union their elements, and every replica —
including a fresh boot — converges on the same set. This is verified with two synced clients in
`package/schema/merge_sync_test.ts`.

## Declare the set

```ts
// src/schema.ts
import { type ArrayColumn, s } from "@nzip/lofi/schema";

export const app = s.defineApp({
  tagged: s.table({
    name: s.string(),
    tags: s.array(s.string()).merge("g-set") as unknown as ArrayColumn<"TEXT">,
  }),
});
```

Two constraints of the pinned alpha shape this declaration:

- **The cast is required.** `.merge()` returns the untyped builder (a pinned upstream type bug); the
  cast restores the array column type. The runtime object is unchanged.
- **Keep the g-set table in its own single-table app.** A g-set column destabilizes writes to
  sibling tables in the same app — the conformance canary pins the hang. When the model also needs
  ordinary tables, they belong in a separate app until upstream stabilizes this.

## Write whole sets, converge on the union

Writers always submit their full local set; the merge takes care of the rest:

```ts
const doc = await db.insert(app.tagged, { name: "doc", tags: ["a"] }).wait({ tier: "global" });

// Two clients, offline at the same time:
alice.update(app.tagged, doc.id, { tags: ["a", "b"] });
bob.update(app.tagged, doc.id, { tags: ["a", "c"] });

// After both reconnect, every replica reads ["a", "b", "c"].
```

The set is grow-only: the verified behavior is that concurrent writes union. Removing an element is
not part of the verified surface — if entries must be retractable, model the collection as its own
table with one row per element and delete rows under an ordinary policy instead.
