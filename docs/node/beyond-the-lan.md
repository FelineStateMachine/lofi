# Deploying beyond the LAN

<!-- Source: FelineStateMachine/lofi-node README.md, docs/hosting-lofi-apps.md,
     deno.json compile task, src/native/loader.ts. -->

A node on a trusted LAN needs nothing beyond the tutorial. Leaving the LAN — a VPS, a reachable home
server, tickets that travel — adds four concerns: the address you pin into tickets, TLS, the relay
your mesh rides, and the binary you actually run.

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

## Bring your own relay

Paired nodes hole-punch direct connections wherever possible; an
[iroh relay](https://docs.iroh.computer/concepts/relays) assists that hole-punching and carries the
traffic that cannot go direct. Out of the box a node uses n0-computer's **public relays**: shared by
every iroh developer, rate-limited, no uptime guarantees. That default exists so the tutorial works
in thirty seconds; n0 blesses it for development and testing, and a production mesh should not lean
on it.

```sh
lofi-node init --relay https://relay.example.net
```

The relay is part of what you self-host, and it fits the machine you already have: `iroh-relay` is a
single open-source binary with built-in Let's Encrypt support, cheap to run because it only carries
the non-direct residue of your own mesh's traffic. The publicly reachable machine hosting your root
node is its natural home. Each node elects its **own** relay (`relay` in
[config.json](configuration.md)), and the election travels inside that node's pairing tickets, so
nothing has to be coordinated across the mesh — no lofi-run infrastructure, no shared choke point.
Your mesh's availability depends only on machines you operate.

`--relay` accepts several URLs (comma-separated or repeated) for failover. `--no-relay` opts out
entirely; defensible for nodes that are all mutually reachable (static IPs, a VPN), but it also
forgoes relay-assisted address discovery, so expect hole-punching to suffer across NATs.

## One binary

```sh
deno task compile   # → dist/lofi-node
```

The compiled binary embeds the prebuilt native transport layer and extracts it to a version-keyed OS
cache on first run. Artifact digests are pinned in the source, so an extraction that doesn't match
its pin fails loudly. Release binaries cover macOS arm64 and Linux x86_64.

**Windows** is a documented gap: the native layer's build path needs a `libnode.dll` import library
the upstream toolchain doesn't ship for this configuration. On Windows the node runs LAN-only — the
Jazz server works, `status().mesh` reports `{ state: "unavailable", reason: … }`, and
`ticket()`/`pair()` throw typed errors rather than degrade silently.

**Linux aarch64** is a second documented gap: the Jazz engine (jazz-napi) publishes no
linux-arm64-gnu build, so neither a compiled binary nor a native container image can boot on arm64
Linux. The iroh transport layer is built for the platform already; the target returns when the
upstream package appears.

## Run it in Docker

The container image wraps the same compiled binary in a minimal glibc base:
`ghcr.io/felinestatemachine/lofi-node`, published per release, linux/amd64 (per the platform note
above; Docker Desktop and qemu run it on arm64 hosts under emulation).

```sh
docker run --rm -v lofi-node-data:/data ghcr.io/felinestatemachine/lofi-node \
  init --dir /data --port 4802 --public-url https://sync.example.net
docker run -d --name lofi-node --network host \
  -v lofi-node-data:/data ghcr.io/felinestatemachine/lofi-node
```

Everything durable lives in the `/data` volume: `config.json`, the node identity key,
`tickets.json`, and the SQLite store. CLI verbs run through `docker exec` against the same directory
and take effect without a restart, exactly as outside a container:

```sh
docker exec lofi-node lofi-node ticket issue --dir /data --label phone
```

Two container-specific choices matter:

- **Networking.** Host networking keeps Docker's bridge NAT out of iroh's hole-punching path. A
  bridge network with a published port (`-p 4802:4802`) serves apps through the gate without issue,
  but paired nodes behind it are more likely to fall back to relayed traffic
  ([the relay's role](pair-two-homes.md)). Host networking is a Linux feature; Docker Desktop
  supports it from version 4.34.
- **The health check** probes `http://127.0.0.1:4802/health`. A node initialized with a different
  `--port` needs the check overridden in compose.

The image runs as uid 1000. Named volumes inherit that ownership; a bind mount must be writable by
uid 1000 (`chown 1000:1000 <dir>`) or the storage probe fails at boot, naming the path. The
repository's [compose.yaml](https://github.com/FelineStateMachine/lofi-node/blob/main/compose.yaml)
is the reference deployment.

## The version invariant

A node pins the **exact** Jazz alpha of the apps it serves; version bumps are coordinated changes,
never drive-by. Before pointing the apps you rely on at your node, confirm the pins match — a
mismatched pair fails in protocol-level ways no amount of network configuration fixes. See
[troubleshooting](troubleshooting.md) for what the mismatches look like.
