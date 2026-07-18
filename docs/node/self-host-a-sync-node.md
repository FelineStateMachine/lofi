# Self-host your first sync node

<!-- Source: FelineStateMachine/lofi-node docs/hosting-lofi-apps.md and cli.ts; validated flow. -->

By the end of this tutorial you will have a sync node running on your own machine, an app-connect
ticket in hand, and a lofi app you use syncing against it. You are the app's user here, not its
developer: the app stays exactly as it was deployed, and pointing it at your node is entirely your
call. Nothing below requires a cloud account, a static IP, or TLS on a trusted LAN — one binary and
one paste.

## 1. Install lofi-node

Install the tool from [JSR](https://jsr.io/@nzip/lofi-node), which puts `lofi-node` on your PATH:

```sh
deno install -g -A -n lofi-node jsr:@nzip/lofi-node/cli
```

For a single self-contained binary instead, compile from a checkout of
[lofi-node](https://github.com/FelineStateMachine/lofi-node):

```sh
deno task compile   # → dist/lofi-node
```

Either way, the native transport layer covers macOS arm64/x86_64 and Linux x86_64/aarch64; on
Windows the node runs LAN-only ([why](troubleshooting.md)).

## 2. Initialize and start

```sh
lofi-node init --dir ./data --port 4802 --public-url http://192.168.1.10:4802
lofi-node start --dir ./data
```

`init` writes `data/config.json`: a generated Jazz app id, the node's secrets, your access mode, and
storage choice. New inits are **ticket-gated** — only requests carrying an issued app-ticket secret
reach the store; `--open` opts out for dev setups. The embedded Jazz server binds loopback-only; the
node's access gate owns the public port, so the gate is both enforcement and reachability.

`--public-url` is the base address that will be embedded in the tickets you issue — use the address
other devices on your network can reach. `--storage-path /mnt/nas/lofi` puts the store on any
mounted location; `--memory` keeps everything ephemeral ([storage choices](storage-choices.md)).

`start` prints the gate URL and, when the mesh is up, the node-pairing ticket for
[pairing a second node](pair-two-homes.md).

## 3. Issue an app ticket

```sh
lofi-node ticket issue --dir ./data --label phone
# → lofisync1.eyJ2IjoxLCJhcHBJZCI6…   (shown once; the secret is never stored)
```

The ticket is one string carrying the store's app id and the gate URL with an access secret embedded
in its path. It is displayed exactly once — the node keeps only a digest. Issue one per device or
context (`--label` is for your own bookkeeping), so revocation stays scoped:

```sh
lofi-node ticket list --dir ./data
lofi-node ticket revoke <id> --dir ./data   # live connections close within seconds
```

Scopes matter later: a plain ticket is transport-only; `ticket issue --provision` mints one that can
also [set up the store's schema](provision-a-store.md). What the string actually contains and why
the secret lives in the URL path: [Tickets explained](tickets-explained.md).

## 4. Enroll the ticket in a lofi app

Paste the ticket into the app — a lofi app with sync exposes enrollment in its account UI. That
declares your node as the device's sync location and elects sync in one step; the data you already
made in the app pushes up under the same account identity. Nothing about the app changes or
redeploys — pointing it at your node is your call, not the app developer's.

(If you are the app developer: the framework side is one call, `enrollSyncTicket`, documented in
[Sync and recovery](/docs/sync-and-recovery).)

## 5. Verify

- `GET <gate-url>/health` answers without a ticket — safe for liveness probes.
- `GET <ticket-url>/store-status` answers for any valid ticket with metadata about the store's
  schema. A fresh node reports `{ "schema": { "deployed": false } }` — that is expected, and it is
  exactly the state the [store provisioning tutorial](provision-a-store.md) resolves. An app should
  not sync against a store with no schema; its writes would hang rather than fail.
- `lofi-node status --dir ./data` shows configuration, tickets, upstream, and mesh state without
  starting anything.

## Where you are

You have a node, a ticket, and an enrolled app — but the store may not have a schema yet. Continue
with [Provision a store](provision-a-store.md), or connect a second node with
[Pair two homes](pair-two-homes.md).
