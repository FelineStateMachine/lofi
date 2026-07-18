# Deploying beyond the LAN

<!-- Source: FelineStateMachine/lofi-node README.md, docs/hosting-lofi-apps.md,
     deno.json compile task, src/native/loader.ts. -->

A node on a trusted LAN needs nothing beyond the tutorial. Leaving the LAN — a VPS, a reachable home
server, tickets that travel — adds three concerns: the address you pin into tickets, TLS, and the
binary you actually run.

## Pin the public URL

```sh
lofi-node init --public-url https://sync.example.net
```

`publicUrl` is the base embedded in every issued ticket. It must be the address enrolled devices
will reach — not `localhost`, not an internal IP that stops resolving off-network. It can be changed
per-issuance (`ticket issue --url …`), but pinning it at init keeps tickets consistent.

## Front the gate with TLS

The gate speaks plain HTTP; beyond a trusted LAN, put TLS in front of it (a reverse proxy such as
Caddy or nginx terminating `https://` and forwarding to the gate's port) and issue tickets with the
`https://` public URL. Two reasons, one hard and one practical: the ticket URL is a bearer
credential and should not transit networks unencrypted; and installed PWAs generally require a
secure origin, so an app enrolled over plain http may work in a tab and fail as an installed app.

Note what TLS does **not** change: the ticket still gates access, revocation still works the same,
and the WebSocket upgrade still rides the same URL — the browser client derives its endpoints from
the http(s) base.

## One binary

```sh
deno task compile   # → dist/lofi-node
```

The compiled binary embeds the prebuilt native transport matrix — macOS arm64 and x86_64, Linux
x86_64 and aarch64 — and extracts the right library to a version-keyed OS cache on first run.
Artifact digests are pinned in the source, so an extraction that doesn't match its pin fails loudly.

**Windows** is a documented gap: the native layer's build path needs a `libnode.dll` import library
the upstream toolchain doesn't ship for this configuration. On Windows the node runs LAN-only — the
Jazz server works, `status().mesh` reports `{ state: "unavailable", reason: … }`, and
`ticket()`/`pair()` throw typed errors rather than degrade silently.

## The version invariant

A node pins the **exact** Jazz alpha of the apps it serves; version bumps are coordinated changes,
never drive-by. Before pointing the apps you rely on at your node, confirm the pins match — a
mismatched pair fails in protocol-level ways no amount of network configuration fixes. See
[troubleshooting](troubleshooting.md) for what the mismatches look like.
