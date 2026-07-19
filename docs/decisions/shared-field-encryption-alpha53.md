# Shared-field encryption: lofi-owned key distribution over a key-relaying server

Date: 2026-07-19\
Decision: implement group-readable, server-sealed columns with a lofi-owned construction —
self-derived x25519 account identities, a self-published key directory with trust-on-first-sight
fingerprint pinning, authenticated (not anonymous) key wraps distributed as ordinary synced rows,
state-valued reads over an in-memory keyring, mutation-layer sealing, and lazy rekey on removal

## Question

Account-private encrypted columns seal content from the store operator but are unreadable to every
other account by design. Fields a whole group should read need a field key distributed to members —
and key distribution through the store is mediated by exactly the adversary the sealing exists for.
What construction keeps the server unable to read shared content, makes its remaining attack
detectable, and fits an engine whose column transforms are synchronous and whose client API exposes
no account key material?

## Contract IDs

The threat-model disclosure page's shared-fields section and residual-exposure statements; the
shared-columns section of `docs/data-and-ui.md`; the `sharedFieldAccess`/`groupAccess(fieldKeys)`
template semantics in `docs/permissions.md`.

## Exact versions

`@nzip/lofi` 0.7.0 working tree; `jazz-tools@2.0.0-alpha.53` unchanged; `@noble/curves@1.9.7`
(x25519) added alongside the pinned `@noble/ciphers@1.3.0` and `@noble/hashes@1.8.0`.

## Control

Account-private encrypted columns only: a row shared with another account is undecryptable for them,
and reads refuse loudly. No group-readable sealed fields existed.

## Decision

1. **Self-derived identities, because the engine exposes none.** The pinned client API surfaces only
   `user_id` strings — no account public keys, no sealed-box primitive. Each account derives an
   x25519 keypair from its account secret (HKDF, info `lofi:shared-fields:x25519:v1`, key separated
   from the encrypted-column hierarchy) and self-publishes the public key in a directory table
   compiled to world-readable, self-only-write policy. Public keys are public; integrity comes from
   pinning, not hiding.
2. **Authenticated wraps, because the server knows every public key.** An anonymous sealed box would
   let the server mint a fresh "generation" wrapped to every member and harvest future writes. The
   wrap therefore mixes an ephemeral exchange with the sender's static key: forging one requires a
   member's secret. Full row context — group table, group id, generation, recipient, sender — binds
   as associated data, so wraps cannot replay across any of those axes.
3. **Detection by pinning, with an out-of-band upgrade.** Devices pin peer fingerprints on first
   sight; sharing identities minted by a shared-field-capable app carry the account's fingerprint
   (`lofi2:<appId>:<userId>:<fingerprint>`), so members added person-to-person are pinned with no
   server first-sight window. A published key that later disagrees is refused — fields stay sealed,
   the mismatch surfaces as a diagnostics alert, and only explicit re-trust resolves it.
4. **State-valued reads over a keyring, because transforms are synchronous.** The stored value
   carries its scope and generation (`encs1.<groupTable>.<groupId>.<generation>.…`), the read
   transform resolves keys from an in-memory keyring the wrapped-key watcher fills, and a missing
   key surfaces as `pending-key` rather than an exception — a thrown transform fails the whole
   query, and key-pending is the normal state of a freshly added member. Live queries resubscribe on
   keyring change, so pending rows re-materialize into plaintext.
5. **Mutation-layer sealing, because only the row knows its group.** The write path resolves the
   group from the configured sibling column and seals with the newest held generation before
   journaling; the column transform merely verifies the sealed prefix, so a write bypassing the
   framework fails closed instead of storing plaintext.
6. **Lazy rekey on removal.** Removal mints a generation past everything visible locally or
   remotely, wrapped only to remaining members. Old generations are not re-encrypted: the removed
   member already possesses that key material, and rewriting merged CRDT history is unsound. Removal
   protects future content, and the documentation says exactly that.
7. **Policy routing around an engine propagation gap.** During verification, cross-account sync was
   found not to deliver rows whose read policy is an exists-based function condition, while
   `always()` and direct object conditions propagate (pinned by an engine canary). The construction
   is unaffected by design — wrapped keys ride a direct recipient condition, the directory reads
   `always()`, and content protection comes from sealing rather than read-policy scoping — but the
   finding stands on its own for the collaboration templates and is tracked as a standing upstream
   issue.

## Consequences

For shared fields the server is an active attacker rather than a passive reader, and its one
remaining move — key substitution during membership changes — is a detected failure. Residual
exposures, stated rather than hidden: trust-on-first-sight for peers first seen only through the
directory; removed members keep the generations they already held; structure, timing, and size-class
metadata remain visible. Key delivery is asynchronous — new members read `pending-key` until an
online key-holding device wraps for them, with a repair operation closing gaps. The construction is
designed to be superseded: engine-authenticated account keys, when the pinned engine exposes them,
replace the directory and pin store with identity material the server cannot substitute at all,
reviewed on every version bump.
