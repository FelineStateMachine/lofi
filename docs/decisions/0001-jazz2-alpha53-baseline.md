# 0001: Graduate the Jazz 2.0.0-alpha.53 data path with lofi-owned edges

Status: accepted for M1 integration\
Date: 2026-07-15\
Issue: #7\
Evidence:
[`spikes/jazz2-baseline/evidence/2026-07-15.md`](../../spikes/jazz2-baseline/evidence/2026-07-15.md)

## Decision

Use the relational Jazz 2 API from the exact `jazz-tools@2.0.0-alpha.53` npm pin for the M1
prototype:

- declare the schema with `schema.table` and `schema.defineApp`;
- create one browser `Db` with the persistent driver and a namespaced `BrowserAuthSecretStore`
  identity;
- render reactive state from `Db.subscribeAll`;
- treat a write as locally retained only after `wait({ tier: "local" })`;
- treat a cloud write as confirmed only after `wait({ tier: "global" })`; and
- keep raw Jazz setup, worker configuration, and transport details behind lofi's runtime module.

Keep `JAZZ_APP_ID` and `JAZZ_SERVER_URL` as lofi's public configuration names. The Deno/Vite edge
maps the complete validated pair to Jazz's internal `VITE_JAZZ_*` names. `JAZZ_ADMIN_SECRET` and
`BACKEND_SECRET` remain server-only and unprefixed.

## Contract deltas

- Revise `DX-OBS-01`: configuration proves only that sync is configured. This pin has no public live
  connection-state or pending-operation-count API. lofi may report per-write local/global
  confirmation and explicitly unavailable detail, but not fabricate “connected”.
- Retain the persistent driver as the default for `DX-DUR-01`; unsupported browser capabilities fail
  boot rather than silently selecting memory.
- Validate the desktop/browser portion of `DX-LOCAL-01` and the vendor portion of `DX-SYNC-01`.
  Integrated Astro/Preact ownership remains for #5/#6.
- Confirm the lofi-owned environment names for `DX-ENV-01`; the final Astro build still has to pass
  server-secret scanning.

## Why

The exact package passed local writes, subscription updates, reload retention, offline writes,
multi-tab propagation, managed-cloud global durability, and a clean second-client download. Its
relational API matches lofi's intended author model without inventing a second schema language.

The package is alpha and its framework integration assumes a conventional npm layout. Keeping the
edge lofi-owned lets the product absorb the required Deno/Vite filesystem allowance, first-run env
pre-seeding, singleton lifecycle, and secret-safe command output without leaking those mechanics
into product UI.

## Rejected alternatives

- **Use Jazz Classic 0.20 APIs from `init.md`:** those CoValue APIs do not describe this package.
- **Wrap Jazz in a provider-neutral data abstraction now:** M1 has no second provider and would
  merely create an untested shadow API.
- **Report connection state from configuration:** a configured URL is not transport evidence.
- **Fall back to memory automatically:** this violates retained-write and failure-honesty promises.
- **Track the generated Vite-prefixed `.env`:** it makes vendor implementation names part of the
  public contract and does not solve secret-safe cloud configuration.

## Sources

- [Exact npm package](https://www.npmjs.com/package/jazz-tools/v/2.0.0-alpha.53)
- [Jazz source snapshot inspected for context](https://github.com/garden-co/jazz/tree/3384730e1c4509524b38c52fc9102fc6753411aa)
- [Official TypeScript local-first starter at that snapshot](https://github.com/garden-co/jazz/tree/3384730e1c4509524b38c52fc9102fc6753411aa/starters/ts-localfirst)
