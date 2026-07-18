# Configuration

<!-- Source: FelineStateMachine/lofi-node src/config.ts (NodeConfig, migration) and
     src/appticket.ts (tickets.json). -->

A node's durable state is two JSON files in its data directory, plus a small set of environment
variables. Both files are owned by the node; edit `config.json` only with the daemon stopped.

## config.json (v2)

```jsonc
{
  "v": 2,
  "appId": "cfe52e44-…", // Jazz app id, generated at init (UUID — required by the engine)
  "backendSecret": "lofi_backend_…", // Jazz credential; server-side only
  "adminSecret": "lofi_admin_…", // authorizes schema/permission administration
  "listenPort": 4802, // optional fixed public port; auto-allocated when absent
  "access": "ticket", // "ticket" (CLI-init default) | "open" (dev; library default)
  "storage": { "type": "sqlite", "path": "/mnt/nas/lofi" }, // or { "type": "memory" }
  "publicUrl": "http://192.168.1.10:4802", // base embedded in issued tickets
  "upstream": "none", // "none" | { "url": "wss://…" } | { "peer": "endpoint…" }
  "relay": "n0", // "n0" (default when absent) | { "urls": ["https://…"] } | "disabled"
  "allowLocalFirstAuth": true
}
```

- **`access`** — `ticket` puts the access gate in front of everything; `open` proxies
  unauthenticated (the gate still owns the public port and the Jazz server still binds
  loopback-only).
- **`storage`** — the honest engine surface: a SQLite directory (optional path, probed writable at
  boot) or memory. See [storage choices](storage-choices.md).
- **`upstream`** — `"none"` for a root node; `{ "peer": … }` for an iroh-paired leaf
  ([pairing](pair-two-homes.md)); `{ "url": … }` for a plain HTTP(S) upstream Jazz server.
- **`relay`** — which relay servers the node's iroh endpoint uses for hole-punching assistance and
  as a fallback path when a direct connection cannot be established. `"n0"` (the default when
  absent) uses the public n0-computer relays: rate-limited, no SLA, meant for development and
  testing. `{ "urls": […] }` points at relays you run ([bring your own relay](beyond-the-lan.md));
  `"disabled"` forgoes relays entirely, including relay-assisted address discovery. The elected
  relay travels inside this node's pairing tickets, so peers need no matching configuration.
- **Secrets** stay in this file and never transit issued tickets; a provision-scoped ticket causes
  the gate to inject `adminSecret` server-side rather than revealing it.

**v1 migration**: v1 files load transparently with legacy defaults applied (`access: "open"`, SQLite
storage) and are rewritten as v2 on the next save.

## tickets.json

```jsonc
{
  "v": 1,
  "tickets": [
    {
      "id": "a1b2c3d4e5f6", // first 12 hex chars of the secret's SHA-256
      "scope": "provision", // absent means "sync"
      "label": "laptop-admin",
      "secretHash": "…", // full SHA-256 hex — the secret itself is never stored
      "createdAt": "2026-07-18T…",
      "revokedAt": "2026-07-19T…" // present only once revoked
    }
  ]
}
```

The CLI writes this file; a running daemon only reads it, picking up changes by modification time —
which is why `ticket issue` and `ticket revoke` need no IPC and no restart.

## Environment variables

| Name              | Effect                                                                |
| ----------------- | --------------------------------------------------------------------- |
| `LOFI_NODE_DEBUG` | `1` enables `[gate]`/`[tunnel]` debug logging to stderr.              |
| `LOFI_NODE_IROH`  | Explicit path to the native transport library, overriding resolution. |
