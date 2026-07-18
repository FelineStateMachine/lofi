# Provision a store

<!-- Source: lofi docs/store-provisioning.md + FelineStateMachine/lofi-node
     tests/provisioning_test.ts (the executable version of this tutorial). -->

A fresh node has no schema deployed, and an app must never sync against a store in that state — the
engine's writes hang rather than fail. Provisioning is the explicit step you opt into that creates
or updates the store's schema, and this tutorial walks it end to end: first app in, then a **second
app joining the store that already holds the first app's data**. Every step here is also executable
— lofi-node's `tests/provisioning_test.ts` runs this exact flow through the gate in CI.

## 0. The opt-in: a provision ticket

```sh
lofi-node ticket issue --dir ./data --provision --label laptop-admin
```

A provision-scoped ticket is a strict superset of a sync ticket: transport plus store
administration. For provisioning requests the gate injects the node's own admin secret and strips
any inbound one — the secret never transits the client, and possession of the ticket **is** the
opt-in. Issue one per provisioning context, not per device.

## 1. Preflight

Any valid ticket — sync scope included — may ask the node where the store stands:

```
GET <ticket-url>/store-status
→ { "v": 1, "appId": "…", "schema": { "deployed": false } }
```

On the app side this is `readTicketStoreStatus(ticketUrl)`, and with administration in hand the
richer classifier is `readStoreStatus(root, target)`, which reports one of `ok`, `no_schema`,
`schema_out_of_date`, or `schema_drift`. `deployed: false` here means `no_schema`: create.

## 2. First app: create

With the app's nested schema and merged permissions bundle:

```ts
import { provisionStore } from "@nzip/lofi/schema/store";
import { permissions, root } from "./schema.ts";

await provisionStore({
  app: root,
  permissions,
  target: { serverUrl: provisionTicketUrl, appId: ticketAppId },
});
// → { status: "created", headHash: "…" }
```

Note the absent `adminSecret` — the provision ticket's gate injection carries administration.
`store-status` now reports `deployed: true` with the head hash, and enrolled devices sync normally.

## 3. Second app: merge into an occupied store

Time passes; the store holds `taskapp` data. Now a notes app — its own namespaces, its own
deployment — enrolls against the same store. Its preflight reports `schema_out_of_date` with exactly
its missing tables, and its opt-in provisioning **merges its slice** rather than replacing anything:

- The stored head schema is fetched verbatim and only extended — the first app's tables keep their
  exact serialization.
- The union deploys as an ordinary migration advancing the store's one permissions head, with the
  first app's policies preserved unchanged and the second app's swapped in for its own tables only.
- The joining app's own compiled schema is registered and connected to the head, so its clients are
  never disconnected.

```ts
await provisionStore({ app: notesRoot, permissions: notesPermissions, target });
// → { status: "updated", headHash: "…" }
```

The first app's devices keep working untouched across the merge — their schema stays connected
through the migration chain — and its access rules still hold: a user who couldn't read a gated
`taskapp` row before the merge still can't after it. Why apps can't step on each other here is the
subject of [Sliceable apps and shared stores](sliceable-apps-and-shared-stores.md).

## 4. What provisioning refuses

- **Drift is never auto-repaired.** If the store's copy of an app's own namespaces differs from what
  the app declares, provisioning throws with the differing tables. A human decides.
- **Out-of-namespace changes are hard errors** before any request is made.
- **Sync-scoped tickets cannot provision**: admin routes answer the same
  `401 {"error":"invalid_ticket"}` as an unknown ticket — nothing to enumerate.

## Through a paired leaf

Provisioning against a [paired](pair-two-homes.md) leaf lands on the root: catalogue writes ride the
iroh tunnel's HTTP path. Deploy wherever is convenient; the root's store is what advances.
