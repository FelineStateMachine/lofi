# CLI

<!-- Source: FelineStateMachine/lofi-node cli.ts (USAGE block and argument parsing). -->

```
lofi-node — self-hostable sync node for lofi apps

Usage:
  lofi-node init   [--dir <dataDir>] [--app-id <id>] [--port <n>]
                   [--public-url <base>] [--open] [--storage-path <path>] [--memory]
                   [--relay <url[,url…]>] [--no-relay]
  lofi-node start  [--dir <dataDir>]
  lofi-node pair   <node-ticket> [--dir <dataDir>]
  lofi-node ticket issue  [--label <s>] [--url <base>] [--provision] [--dir <dataDir>]
  lofi-node ticket list   [--dir <dataDir>]
  lofi-node ticket revoke <id> [--dir <dataDir>]
  lofi-node status [--dir <dataDir>]
```

The data directory defaults to `./lofi-node-data` everywhere.

## init

Creates the data directory and writes [`config.json`](configuration.md): a generated Jazz app id (or
`--app-id` to pin one), fresh backend and admin secrets, and your choices.

| Flag                    | Meaning                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `--port <n>`            | Fixed public port for the gate; auto-allocated when omitted.                                              |
| `--public-url <base>`   | Base URL embedded in issued tickets (use the reachable address).                                          |
| `--open`                | Opt out of ticket gating — anyone who can reach the port can sync. CLI inits default to **ticket-gated**. |
| `--storage-path <path>` | SQLite store on any mounted location; probed writable at boot.                                            |
| `--memory`              | Ephemeral in-memory store.                                                                                |
| `--relay <url[,url…]>`  | Use your own iroh relay(s) instead of the public n0 servers ([why](beyond-the-lan.md)). Repeatable.       |
| `--no-relay`            | No relays at all: direct connections only.                                                                |

## start

Starts the daemon from an initialized directory: boots the loopback-only Jazz server, opens the
public gate, loads the native transport when available, and prints the gate URL plus the
node-pairing ticket when the mesh is up.

## pair

`lofi-node pair <node-ticket>` elects the peer as this node's upstream — the node becomes a leaf
relaying sync and catalogue traffic over iroh. The argument is a node-pairing `endpoint…` string
from the peer's `start` output, not an app ticket (the CLI rejects app tickets with a pointed
message). Re-electable at runtime; the public port does not change.

## ticket issue / list / revoke

`issue` mints an app-connect ticket and prints it **exactly once** — the node stores only a digest.
`--label` names it for your bookkeeping, `--url` overrides the embedded base for this ticket, and
`--provision` mints a provision-scoped ticket that can also administer the store
([scopes](tickets-explained.md)).

`list` shows every issued ticket: id, scope, label, issued time, and revocation state. `revoke
<id>`
invalidates one; a running daemon picks the change up within seconds and closes the ticket's live
connections with close code 4001 — no restart, no IPC.

## status

Prints configuration and live state without changing anything: access mode, storage, relay election,
issued tickets, upstream election, and mesh state (up with connection stats, off, or unavailable
with the reason).
