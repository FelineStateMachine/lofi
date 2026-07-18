# Browser convergence: no upstream defect — the gate never elected sync

Date: 2026-07-18\
Decision: reject the "upstream convergence defect" diagnosis; fix the gate's preconditions; classify
`CatalogueWriteDenied` at boot as benign upstream console noise, not a sync failure

## Question

The browser convergence gate (`apps/reference/tests/convergence_e2e_test.ts`) failed with
`CatalogueWriteDenied` "identically against lofi-node and lofi's own managed dev server", and this
was recorded as an upstream jazz-tools alpha.53 defect (lofi-node `docs/hosting-lofi-apps.md`
validation status; #123 items B1/B3/C1; the homepage caveat in #122 §1). Is it actually upstream,
and what is the minimal reproduction?

## Contract IDs

DX-LOCAL-01 and DX-OFFLINE-01 surround the behavior; the affected claim is the documented
"known-broken two-browser reconciliation" status itself, which gated homepage copy (#122 §1).

## Exact versions

`jazz-tools@2.0.0-alpha.53` / `jazz-napi@2.0.0-alpha.53`, lofi main at the A3-phase-2 merge,
lofi-node main at the docs-adoption merge, Playwright Chromium (pinned 1.61.1 install).

## Control

Headless two-client convergence (`jazz-tools` `createDb` clients, same account, concurrent offline
edits) against lofi-node — passing throughout (lofi-node `tests/convergence_test.ts`).

## Procedure

Instrumented probe (per-client console capture, CDP WebSocket frames, per-direction convergence
checks with independent timeouts), run in four configurations: dev server without managed config;
managed server with deployed schema but no sync election; managed server with the real
backup-and-sync election performed through the account UI before identity cloning; the same against
a lofi-node backend with the schema deployed through its admin path.

## Evidence

1. Both clients — including the first, alone, at boot, before any offline edit — log
   `CatalogueWriteDenied` (`sync_manager/inbox.rs:1401`) for the same content-addressed object id on
   every server and store, deployed schema or not. The denial is not correlated with the second
   client or with reconnection.
2. Without election, neither client held any `lofi:` state: no `sync-elected`, no managed namespace.
   Both ran local-only — lofi's own documented first-boot contract — so non-convergence was the
   designed outcome, identical against every server. The historical "controlled experiment" compared
   two non-syncing runs; its parity conclusion was vacuous.
3. With the election performed (virtual authenticator, the real two-step phrase ceremony), the
   identical scenario converges in all four directions in ~1s — online-only and offline-reconnect —
   against both the first-party managed server and lofi-node. The `CatalogueWriteDenied` warning
   still appears once per client at boot while sync works, proving it benign.
4. A second latent failure hid the first: the documented invocation used `127.0.0.1`, where the
   election ceremony cannot start because an IP address is not a valid WebAuthn RP ID. On
   `localhost` the ceremony works.

## Decision

- The gate now performs the backup-and-sync election in `preparePrimary` before identity cloning,
  and its instructions require `localhost`. It passes against both servers.
- B1 (distill an upstream repro) resolves as **not upstream** for convergence. The remaining
  upstream observation is cosmetic: every browser client attempts one unauthorized catalogue write
  at boot and logs a WARN — worth an upstream polish report, not a standing defect issue.
- B3 (standing upstream issue for "browser reconnect denial") is **not filed**: its condition — a
  verifiable upstream defect — does not exist.
- C1 (expected-fail canary) is moot in its planned form; the fixed gate is the assurance artifact.

## Contract delta

"Two real browser clients reconciling after offline edits" moves from known-broken to validated
against both servers. The lofi-node validation-status claim and the #122 §1 homepage constraint ("do
not re-point this copy until the upstream fix lands") are both superseded — the scenario the
homepage describes works and can be claimed truthfully.

## Follow-up

lofi-node `docs/hosting-lofi-apps.md` validation status rewritten (companion PR); #122 §1 unblocks;
optional: promote the convergence scenario into the golden suite for continuous coverage, and an
upstream courtesy report for the boot-time catalogue-write warning.
