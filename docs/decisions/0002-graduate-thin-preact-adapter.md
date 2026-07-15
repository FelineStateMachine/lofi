# ADR 0002: Graduate the thin Preact adapter

Status: accepted\
Date: 2026-07-15\
Issues: #5, #6

## Decision

Use Preact directly over a small lofi-owned external store backed by Jazz's vanilla `Db` API. Keep
one browser-global database promise, share one vendor query subscription across equivalent island
consumers, and replace adapter instances during HMR without shutting down the database.

Product components may use Preact, lofi hooks, and application types. They may not import Jazz,
construct a client/provider, choose a transport, or branch on storage implementation.

## Why

Jazz 2.0.0-alpha.53's React bindings require React 19's `use`. Preact 10.29.7 compat does not export
that API, so the alias-only control fails its production build. A custom semantic polyfill would be
a larger and riskier compatibility layer than the adapter it was meant to avoid.

The thin path passed two-root reactivity, retained local writes, explicit and concurrent client
recreation, teardown, error visibility, deferred-initialization disposal, and five HMR cycles. Its
reachable JavaScript is 6,983 gzip bytes larger than the single-view vanilla API control; that is an
indicative floor rather than an equivalent-UI bundle claim.

## Consequences

- Jazz alpha churn is isolated to `apps/prototype/src/runtime` and schema/config files.
- Component authors get context-free hooks that work across independent Astro islands.
- The adapter owns query snapshot identity, cleanup, mutation error mapping, and HMR lifecycle.
- Deferred asynchronous subscription failures remain limited by Jazz's public API and must not be
  represented as observable UI errors until the vendor exposes a channel.
