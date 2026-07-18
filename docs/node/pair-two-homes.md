# Pair two homes

<!-- Source: FelineStateMachine/lofi-node README.md, src/tunnel.ts, src/node.ts (pair/status). -->

Two nodes in two places — a home server and a studio machine, say — can hold the same store and
converge over [iroh](https://iroh.computer): dialed by public key, hole-punched through NATs, no
static IPs, no port forwarding, no cloud dependency. Devices keep syncing against whichever node is
closest; the nodes reconcile with each other.

## Pairing

Every node with the mesh up prints a **node-pairing ticket** on start — an iroh `endpoint…` string,
distinct from the `lofisync1.` app tickets users enroll. On the second node:

```sh
lofi-node pair endpoint… --dir ./data
```

or at runtime, without a restart and without the public port changing:

```ts
await node.pair(otherNodeTicket);
```

Pairing is an **upstream election**: the paired node becomes a leaf that forwards to the root. Sync
WebSockets and catalogue HTTP (schema reads, deploys) tunnel over iroh, so administering either node
reaches the root — [provisioning through a leaf](provision-a-store.md) lands on the root's store,
verified end to end in lofi-node's test suite.

## What the tunnel carries

One iroh connection carries exactly one WebSocket or one HTTP request. Each connection opens with a
small HELLO frame naming what it carries (`ws` with path and subprotocol, or `http` with method,
path, and headers); frames then bridge both ways until either side closes. This is why the
browser-facing protocol never changes: the leaf re-originates exactly what Jazz expects.

## Observing the mesh

```ts
node.status().mesh;
// { state: "up", nodeId, ticket, connections: [{ direction, rtt, paths }] }
```

`connections` reports each live tunnel with its round-trip time and path counts — direct versus
relay — so you can see whether hole-punching succeeded or traffic is riding an iroh relay. The other
two states are honest degradations: `{ state: "off" }` when the mesh is disabled, and
`{ state: "unavailable", reason }` when the native layer could not load — the Jazz server still runs
LAN-only, and `ticket()`/`pair()` throw `MeshUnavailableError` rather than pretending.

## The relay's role

Relays assist that hole-punching (address discovery) and carry traffic only for the connections that
cannot go direct; in practice the large majority of iroh connections are direct. The relay is a
**per-node election** (`relay` in [config.json](configuration.md)): whichever relay a node elects
travels inside its pairing ticket, so the dialing side needs no matching configuration. The default
is n0-computer's public relays, which are rate-limited and meant for development. For a production
mesh, [bring your own](beyond-the-lan.md).

## Choosing a root

The root holds the authoritative store; leaves relay to it. Put the root on the machine with the
most reliable storage ([storage choices](storage-choices.md)) and pair outward from there. A leaf's
election can be redone at runtime (`pair` again) if the topology changes.
