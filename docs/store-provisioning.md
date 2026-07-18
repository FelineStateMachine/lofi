# Store provisioning

A user-supplied sync store (a self-hosted node reached by ticket) is shared infrastructure: another
app's tables may already live in it. Provisioning is how an app creates or updates **its own slice**
of such a store — as an explicit user opt-in, never as part of normal sync.

Two principles govern it:

1. **Store changes are opt-in.** Enrolling a sync ticket attaches transport only. Creating or
   updating the store's schema requires store administration: either the store's **admin secret**,
   or a **provision-scoped app-connect ticket** (`ticket issue --provision` on lofi-node), whose
   gate injects the node's admin secret itself — the secret never transits the client, and
   possession of the ticket is the opt-in.
2. **An app may only touch its own namespaces.** A nested app (`s.defineNestedApp`) declares
   namespaces, and every change provisioning generates is confined to tables under them. Sibling
   tables and their policies carry through a merge byte-for-byte. This keeps apps honest: many apps
   can share one store, each owning its slice, none able to clobber another through the framework
   surface. A flat `s.defineApp` schema has no namespace and therefore may only provision a store it
   wholly owns.

Provisioning lives at `@nzip/lofi/schema/store`, deliberately separate from `@nzip/lofi/schema`: the
schema facade is bundled and executed by the Jazz schema loader when deriving the deployed schema,
so the authoring surface stays free of the provisioning client.

## Classify before you connect

With store administration (admin secret, or a provision-scoped ticket URL as `serverUrl` with
`adminSecret` omitted):

```ts
import { readStoreStatus } from "@nzip/lofi/schema/store";

const status = await readStoreStatus(root, { serverUrl, appId, adminSecret });
```

Without it — any valid sync ticket may call the node's metadata-only preflight, which is how a
sync-only client learns `no_schema` before ever attaching sync:

```ts
import { readTicketStoreStatus } from "@nzip/lofi/schema/store";

const preflight = await readTicketStoreStatus(ticketUrl);
// → { state: "deployed", appId, headHash } | { state: "no_schema", appId }
//   | { state: "store_unavailable" } | { state: "ticket_rejected" } | { state: "unsupported" }
```

| State                | Meaning                                                          | Remedy               |
| -------------------- | ---------------------------------------------------------------- | -------------------- |
| `ok`                 | The enforced schema carries this app's slice exactly.            | none                 |
| `no_schema`          | Nothing is deployed. **Writes against such a store hang.**       | opt-in create        |
| `schema_out_of_date` | The store lacks some of this app's tables.                       | opt-in update        |
| `schema_drift`       | The store's copy of this app's namespaces differs unexplainably. | surfaced, never auto |

`no_schema` is why classification exists beyond provisioning: against an empty store the engine's
writes hang rather than fail, so an app should reach this state — and prompt the user — before ever
attaching sync to a fresh store.

## Provision

```ts
import { provisionStore } from "@nzip/lofi/schema/store";
import { permissions, root } from "./schema.ts";

const result = await provisionStore({
  app: root,
  permissions, // the app's merged per-namespace bundle
  target: { serverUrl, appId, adminSecret },
});
// result.status → "created" | "updated" | "unchanged"
```

What a merge actually does, in order:

1. Fetches the store's head schema and permissions bundle verbatim.
2. Appends this app's missing tables to the stored schema object — everything else keeps its exact
   serialization, because the schema hash is serialization-sensitive.
3. Publishes the union schema, a migration from the current head (`added`-table lenses only), and
   the union permissions bundle — sibling policies recovered from the store and preserved unchanged,
   this app's policies swapped in for its own tables — chained to the current head.
4. Registers this app's own compiled schema and connects it to the new head. Clients declare their
   compiled schema hash on the wire, and the server only serves hashes connected to the enforced
   head — without this edge, the joining app's clients would hang on their own tables.

Existing clients of other apps continue untouched across a merge: their hash stays connected through
the migration chain, and their policies were never rewritten.

Drift refuses loudly (`StoreProvisionError` with code `schema-drift` and the differing tables); so
does a permissions bundle naming a table outside the app's namespaces (`outside-namespace`), before
any request is made.

## Current limits

- Table **additions** are the supported merge shape. Evolving columns of already-deployed tables
  (add/drop/rename) still goes through the app's own migration deploy flow; forwarding those through
  provisioning is follow-on work on [#109](https://github.com/FelineStateMachine/lofi/issues/109).
- `readStoreStatus` compares structurally; it does not verify migration connectivity. A
  `provisionStore` run (even an `unchanged` one) establishes the connectivity edge for this app's
  schema, so run it once per app version as part of the opt-in.
- Store administration (the admin secret, or a provision ticket) grants full control; the namespace
  confinement is a framework honesty boundary, not a defense against a hostile administrator.
  Provision-scoped tickets and the store-status preflight are the node-side contract from
  [lofi-node#2](https://github.com/FelineStateMachine/lofi-node/issues/2), shipped in lofi-node's
  `docs/app-ticket.md`.
