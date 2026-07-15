# 0006: Bound Layer 3 inspection and testing to truthful observable seams

Status: accepted for M2 implementation\
Date: 2026-07-15\
Issues: #10, #12

## Decision

Layer 3 graduates two developer surfaces:

- a visible development-only inspector backed by a provisional internal snapshot/action adapter;
- readiness-first Playwright helpers exported from the single package at `@nzip/lofi/testing`.

The inspector is generated runtime machinery, not a public framework facade. `./testing` is the only
new public package export in this layer. Broader `core`, `ui`, `sync`, `auth`, and `pwa` extraction
still requires the M4 evidence described by ADR 0005.

The inspector may report only signals lofi can observe:

- device-local identity and the blocked alpha passkey-backup state;
- requested/open/failed persistent storage plus browser persistence permission;
- local-only or managed-configured mode;
- lofi-wrapped per-write local/global durability and mutation failures; and
- active client, consumer, vendor-subscription, and mutation-listener counts.

The Jazz alpha pin exposes no supported live connection state, vendor queue depth, or multi-tab
leader/follower role. Those fields remain visibly unavailable. Configuration is never presented as
connectivity, and checklist writes are not mislabeled as the vendor's complete pending queue.

Inspector transport pause/resume calls Jazz `Db.disconnect()`/`reconnect()` only when managed sync
is configured and labels the action as a cloud-transport test seam. Real browser offline control is
owned by `@nzip/lofi/testing` through Playwright `BrowserContext.setOffline()`. Client restart uses
a full document reload: Jazz alpha.53 does not reliably reopen the same browser-broker namespace
after an in-document `Db.shutdown()`/`createDb()` cycle, while a document lifecycle restart retains
the locally durable replica. Replica clear uses `Db.deleteClientStorage()` behind a destructive
confirmation, then reloads the document; it clears the local OPFS namespace while preserving the
localStorage identity and warns that unsynced data may be lost.

## Two-client identity rule

The current permissions are creator-only. Two distinct user identities therefore cannot both read
and edit one row, so claiming distinct-identity convergence would be false. The convergence fixture
uses two isolated browser contexts and separate OPFS replicas with the same restored identity. The
first context's Playwright storage state is passed directly to the second context in memory. It is
never written to reports, traces, snapshots, logs, or screenshots because it contains the bearer
identity secret.

A truly distinct-user fixture belongs with sharing/invitation and permission-model work, not this
testing layer.

## Verification boundary

Local acceptance proves readiness predicates, offline restoration in `finally`, restart/reload,
artifact redaction, inspector actions, and production exclusion. Closing the convergence contract
also requires a cloud-configured generated-project journey:

1. seed a row and wait for global durability;
2. boot the second isolated replica with the in-memory restored identity;
3. take both browser contexts offline;
4. make orthogonal edits, then reload/recreate while work remains local;
5. restore network control in `finally` and wait for both visible snapshots to converge; and
6. remove fixture rows and wait for global durability.

Only the public `JAZZ_APP_ID`/`JAZZ_SERVER_URL` pair reaches the child application. Server secrets
remain blank, and no configured value is retained in evidence.

Production builds must contain no lofi inspector marker, global bridge, route, or chunk. Jazz's raw
vendor inspector remains disabled.

## Deferred physical-device evidence

Playwright does not graduate installed-PWA lifecycle, storage eviction, airplane-mode cold launch,
real passkey custody, or mobile background/foreground recovery. Those remain explicit M3 physical-
device gates.

## Why

This boundary gives developers useful controls and deterministic tests without inventing vendor
precision, leaking identity material, weakening creator-only permissions, or prematurely turning the
M1 runtime into a general framework API.
