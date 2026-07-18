# Troubleshooting and compatibility

<!-- Source: FelineStateMachine/lofi-node README.md, docs/hosting-lofi-apps.md
     ("Validation status"), src/errors.ts, src/native/loader.ts. -->

The node's failure modes are designed to be nameable. Work from the signal you see.

## Mesh: `unavailable`

`status().mesh` reports `{ state: "unavailable", reason: … }` when the native transport could not
load; the Jazz server still runs LAN-only and `ticket()`/`pair()` throw `MeshUnavailableError`
rather than degrade silently. Causes, in resolution order:

1. An explicit `LOFI_NODE_IROH` path that doesn't exist.
2. Running from source without building the native layer (`cargo build --release` in
   `native/iroh-js`).
3. An unsupported platform — most notably **Windows**, a documented gap (the `*-gnu` build path
   needs a `libnode.dll` import library the upstream toolchain ships only for msvc). Windows nodes
   run LAN-only until that resolves.

On **arm64 Linux** the limitation sits one layer deeper: the Jazz engine (jazz-napi) publishes no
linux-arm64-gnu build, so the node cannot start at all there. Release binaries and the container
image cover macOS arm64 and Linux x86_64 ([platform notes](beyond-the-lan.md)).

The compiled binary embeds digest-pinned prebuilts; a cache extraction that doesn't match its pin
fails loudly rather than loading.

## 401 `invalid_ticket`

Unknown ticket, revoked ticket, or a sync-scoped ticket on an admin route — deliberately one answer
for all three. If a previously working app starts seeing it, the ticket was revoked: re-enroll with
a fresh one. If provisioning sees it, the ticket lacks `provision` scope.

## WebSocket closes with 4001

The ticket was revoked mid-session. This is the live-revocation path working as designed; the app
should treat its stored sync location as dead and surface re-enrollment, not retry.

## 502 `store_unavailable`

The gate is up but its store is not — the loopback Jazz process, or on a leaf, the tunnel to the
root. Check `lofi-node status` and, for a leaf, `status().mesh.connections`.

## Writes hang; nothing errors

Almost always a store with **no deployed schema** — the engine hangs rather than fails in this
state. `GET <ticket-url>/store-status` reporting `{ "deployed": false }` confirms it; the remedy is
[provisioning](provision-a-store.md). lofi apps classify before attaching sync for exactly this
reason.

## Version mismatch

A node must run the **same Jazz alpha** as the apps it serves. Mismatches surface as protocol-level
failures (schema hash and catalogue errors) that no network configuration fixes. Confirm both pins
before debugging anything else.

## Compatibility status, honestly

The whole flow is validated end to end against lofi's reference app with real browser clients:
build, boot, offline edits, reconvergence, and the full provisioning lifecycle through the gate and
through an iroh-paired leaf. One known upstream finding: lofi's opt-in browser convergence gate
fails at its final stage with a catalogue error **identically against lofi-node and against lofi's
own first-party dev server** — a controlled experiment placing the issue in the pinned Jazz alpha,
not the node. lofi-node's contract docs carry the current validation table.
