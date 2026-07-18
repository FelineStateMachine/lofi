# Tickets explained

<!-- Source: FelineStateMachine/lofi-node docs/app-ticket.md (the normative contract) and
     src/ticket.ts; lofi package/runtime/data-sink.ts for the app side. -->

lofi-node uses two kinds of ticket, and confusing them is the most common early stumble. This guide
is the conceptual tour; the [app-ticket contract](/node/docs/app-ticket) is the normative spec the
lofi side implements against.

## Two ticket kinds

- A **node-pairing ticket** (`endpoint…`) is an iroh endpoint address. It names a _node_ so another
  node can dial it. It is used by `lofi-node pair` and never by browsers or apps.
- An **app-connect ticket** (`lofisync1.…`) is the credential _you_ hand to a lofi app so it syncs
  against your node. It carries the store's app id and the gate URL with a 256-bit secret embedded
  in its path.

## Why the secret lives in the URL path

Jazz clients preserve a base path in their server URL and reject query parameters. By making the
ticket's URL `http(s)://host:port/t/<secret>`, every request the client ever makes — sync WebSocket
connects, catalogue reads, admin calls — carries the secret with **zero client changes**. The gate
validates the secret (timing-safe, digest against digest), strips the prefix, and proxies to the
loopback-only Jazz server. The lofi app uses the ticket URL verbatim as its sync server; that is the
whole integration.

## Scopes

- **`sync`** (the default, and what an absent scope means — every pre-scope ticket keeps meaning
  transport-only): sync, catalogue reads that transport needs, and the metadata-only `store-status`
  preflight. Admin routes answer the same `401 {"error":"invalid_ticket"}` as an unknown secret, so
  a probe learns nothing.
- **`provision`**: a strict superset — everything above plus store administration. The gate injects
  the node's own `X-Jazz-Admin-Secret` for provisioning requests and strips any inbound one, so the
  admin secret never transits the client. Possession of a provision ticket **is** the
  store-administration opt-in; issue one per provisioning context, not per device.

A ticket with an unrecognized scope is rejected outright by the lofi parser — never silently granted
less than it claims.

## Revocation

- The node stores only SHA-256 digests; the ticket string is displayable once, at issuance.
- Unknown and revoked secrets are indistinguishable to probers: both get
  `401 {"error":"invalid_ticket"}`, on HTTP and on the WebSocket upgrade.
- Revoking a ticket mid-session closes its live WebSockets with close code **4001** within a couple
  of seconds. The app treats the stored sink as dead and surfaces re-enrollment — it never silently
  retries forever.

## The security posture, honestly

An app ticket is a **bearer credential** with 256-bit entropy. Anyone holding it can sync as an
authorized transport peer; identity and row-level permissions remain Jazz's local-first layer on
top, enforced by the deployed policy, not by the ticket. Plain http is acceptable on a trusted LAN;
beyond one, front the gate with TLS — installed PWAs generally require a secure origin anyway. Issue
tickets per device or context so revocation is scoped.

## What the app does with it

You paste; the app does the rest. The ticket is validated (against the same rules this node
enforces; the two repos share machine-readable conformance fixtures), declared as the device's sync
location, and sync is elected in one step. The app keeps the ticket URL in a sealed device-local
record (encrypted at rest under a device-bound key) and never surfaces it through its session
snapshot — only the host and your label show. For app developers, the framework call behind that
paste is `enrollSyncTicket`, documented in [Sync and recovery](/docs/sync-and-recovery).
