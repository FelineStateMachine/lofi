# Sliceable apps and shared stores

<!-- Source: lofi #109 (design + conformance), lofi docs/store-provisioning.md and
     docs/examples/nested-namespaces.md, lofi-node #2; jazz-tools typed-app surface. -->

A self-hosted store is shared infrastructure. The user brings the store; apps are tenants in it.
This guide is the mental model that makes that safe: what a slice is, how one store's schema grows
app by app, and why an app cannot damage a neighbor even though the store trusts its administrator.

## A slice is a naming discipline, not a partition

Jazz's pinned DSL compiles **one schema per store** — one hash, one migration lineage, one query
planner. `defineSliceableApp` derives typed sub-app views over that single schema, and lofi's
`s.defineNestedApp` builds the naming layer on top: an app declares namespaces, its tables flatten
to global names with a reserved separator (`taskapp` + `tasks` → `taskapp__tasks`), and app code
uses unprefixed typed handles as if the namespace were its whole world.

Nothing at the storage layer partitions those tables — every table is a sibling of every other in
the one store. The **slice** is the set of tables under an app's declared namespaces, and the
namespace prefix is what makes ownership checkable.

## The store's schema grows slice by slice

The store enforces exactly one schema at a time — the head of a migration lineage. When a second app
joins an occupied store, its provisioning _merges_: the stored schema is fetched verbatim, the app's
missing tables are appended, and the union deploys as an ordinary migration advancing the head.
Devices running the previous schema keep working, because their schema stays connected to the head
through the migration chain.

Four states describe any store relative to any app — the same taxonomy the tooling reports:

| State                | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `ok`                 | The enforced schema carries this app's slice exactly.               |
| `no_schema`          | Nothing is deployed. Writes would hang; never sync in this state.   |
| `schema_out_of_date` | The store lacks some of this app's tables. Remedy: opt-in update.   |
| `schema_drift`       | The store's copy of the app's own namespaces differs unexplainably. |

`no_schema` deserves its emphasis: against an empty store the engine's writes hang rather than fail.
That is why the node exposes a metadata-only `store-status` preflight any valid ticket can call, and
why lofi classifies before attaching sync instead of writing and hoping. `schema_drift` is the
opposite discipline — it is surfaced with the differing tables and **never** auto-repaired; a store
whose copy of your namespace changed under you needs a human, not a merge.

## The honesty invariant

An app's provisioning may create tables **only under its own declared namespaces**. Everything else
in the store — sibling apps' tables _and their access policies_ — carries through a merge
byte-for-byte. Any generated change naming a table outside the app's namespaces is a hard error
before a single request is made. A flat (non-nested) app declares no namespace and therefore gets no
tenant rights: it may only provision a store it wholly owns.

Two properties fall out, both verified against a real server in lofi's conformance suite:

- **Continuity.** The first app's devices write and read across a second app's merge untouched.
- **Policy preservation.** A user who couldn't read a gated row of the first app before the merge
  still can't after it — the joining app re-publishes the union permissions with the sibling's
  policies recovered from the store, unchanged.

Stated honestly: this is a _framework_ boundary, not cryptography. Store administration (the admin
secret, or a provision-scoped ticket) can technically do anything; the invariant keeps apps built on
lofi honest through the surface they actually use. The node-side complement is that a provision
ticket never exposes the admin secret itself — the gate injects it — so handing a user provisioning
power does not hand them a credential to leak.

## Where each piece lives

- Declaring namespaces and per-namespace permissions:
  [nested app namespaces](/docs/examples/nested-namespaces) in the framework docs.
- The classifier and merge flow an app runs: [store provisioning](/docs/store-provisioning).
- Doing it against a node with a provision ticket: [Provision a store](provision-a-store.md).
- The ticket semantics underneath: [Tickets explained](tickets-explained.md) and the
  [app-ticket contract](/node/docs/app-ticket).
