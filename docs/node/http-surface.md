# HTTP surface

<!-- Source: FelineStateMachine/lofi-node src/gate.ts; normative ticket semantics in the
     app-ticket contract. -->

The gate is the node's public face: it owns the public port, validates tickets, and proxies to the
loopback-only Jazz server. This page is the route-level reference for a **ticket-gated** node; in
`open` mode the same routes exist without the `/t/<secret>` prefix or scope checks.

## Routes

| Route                              | Ticket      | Behavior                                                                  |
| ---------------------------------- | ----------- | ------------------------------------------------------------------------- |
| `GET /health`                      | none        | Liveness; proxied to Jazz. `200`, or `502` when the store is unreachable. |
| `GET /t/<secret>/store-status`     | any scope   | Metadata-only schema preflight (below).                                   |
| `/t/<secret>/apps/<appId>/ws`      | any scope   | WebSocket sync; re-originated toward Jazz with subprotocol forwarded.     |
| `/t/<secret>/apps/<appId>/…`       | any scope   | Catalogue reads and other app routes, prefix-stripped and proxied.        |
| `/t/<secret>/apps/<appId>/admin/…` | `provision` | Store administration; the node's admin secret is injected server-side.    |

The `<secret>` is a 43-character base64url path segment; the gate compares digests in constant time,
strips the prefix, preserves the query string, and forwards.

## store-status

```jsonc
// 200
{
  "v": 1,
  "appId": "…",
  "schema": {
    "deployed": true, // false → the object carries only { "deployed": false }
    "headHash": "ff85ac…", // newest stored schema hash (ordered by publishedAt)
    "permissionsHead": "0195…" // current permissions head object id, or null
  }
}

// 502 — the node is up but its store is not
{ "error": "store_unavailable" }
```

Metadata only — never schema contents, policies, or secrets. This endpoint exists so a sync-scoped
client can classify a store (most importantly `no_schema`, where writes would hang) without any
admin capability.

## Errors and close codes

| Signal                              | Meaning                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 {"error":"invalid_ticket"}`    | Unknown ticket, revoked ticket, or a sync-scoped ticket on an admin route — deliberately indistinguishable. On WebSocket, the 401 **is** the upgrade response. |
| WS close `4001` (`ticket revoked`)  | The ticket was revoked mid-session; live sockets close within a couple of seconds. The app treats the sink as dead and surfaces re-enrollment.                 |
| WS close `1011`                     | Upstream dial or pump failure inside the gate.                                                                                                                 |
| `502 {"error":"store_unavailable"}` | Gate up, Jazz (or the tunnel to the root) unreachable.                                                                                                         |

## Header handling

Inbound `X-Jazz-Admin-Secret` headers are **stripped unconditionally** in ticket mode; for
provision-scoped requests on admin routes the gate injects its own. Hop-by-hop headers
(`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `host`, `content-length`) are managed
by the gate in both directions; everything else passes through.
