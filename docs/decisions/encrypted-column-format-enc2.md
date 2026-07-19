# Encrypted-column format enc2: padded plaintext, version-bound associated data

Date: 2026-07-19\
Decision: pad encrypted-column plaintext to bucketed sizes before sealing under a new `enc2.` stored
format; bind the format version into the associated data; keep `enc1.` readable indefinitely with no
migration; extend the sealed column set with number and date scalars

## Question

The stored ciphertext of an encrypted column leaked the exact plaintext length (nonce and AEAD
overhead are constant), so the store operator could distinguish a 3-character note from a
40-character one. How does the format hide content length without a migration pass, and how do two
coexisting formats stay mutually non-replayable when the version marker is a string prefix outside
the AEAD?

## Contract IDs

The affected documented semantics are the encrypted-columns section of `docs/data-and-ui.md` and the
server's-view bullets of `docs/threat-model.md` ("rows of a certain size and cadence exist").

## Exact versions

`@nzip/lofi` 0.7.0 working tree; `jazz-tools@2.0.0-alpha.53` unchanged; cipher unchanged
(XChaCha20-Poly1305 via `@noble/ciphers`, HKDF-SHA-256 per-label subkeys).

## Control

The pre-change behavior: `"enc1." + b64url(nonce24 || ct)` with the raw plaintext as the AEAD
payload and `lofi:encrypted-column:<label>` as associated data. Ciphertext length = plaintext
length + 40 bytes.

## Decision

1. **Padded payload** (`package/schema/padding.ts`): the sealed plaintext is a 4-byte big-endian
   payload length, the payload, then zero fill to a bucket. The padded form is self-describing, so
   the bucket schedule can evolve without a format bump.
2. **Bucket schedule: Padmé with a 64-byte floor.** Every payload whose prefixed length is at or
   under 64 bytes pads to 64 — short scalars (numbers, dates, names, titles) form one
   indistinguishable class. Above the floor, Padmé bounds overhead near 12% while leaking O(log log
   n) bits of length, against 2x worst-case for power-of-two buckets on large JSON.
3. **Version-bound associated data.** enc2 seals with `lofi:encrypted-column:enc2:<label>`; enc1
   values authenticate against the unversioned string. The prefix sits outside the AEAD, so without
   this an attacker could rewrite one prefix into the other and hand the wrong unpacking to an
   authenticated plaintext: an enc1 value reparsed as enc2 would interpret its first four bytes as a
   length. With version-bound AD, a flipped prefix fails authentication in either direction.
4. **No migration.** `seal()` writes only enc2; `open()` dispatches on the prefix. Legacy values
   re-seal as enc2 on their next ordinary write. Both formats remain valid indefinitely; the size
   class the threat model can claim applies to values written from this version on.
5. **Sealed scalars.** `encryptedNumber` and `encryptedDate` serialize inside the plaintext (ASCII
   decimal; epoch milliseconds) over the same seal/open path. Their stored representation is TEXT,
   so sealed numbers do not inherit the pinned i32 integer-column limit (asserted in conformance
   with a 2^40 round trip). A conformance finding is pinned alongside: a `where` carrying a
   plaintext number against a sealed column throws in the query adapter (type mismatch against the
   TEXT stored type) rather than matching zero rows like the string case — loud is acceptable;
   plaintext must never match.

## Consequences

The store operator's view of an encrypted column degrades from exact content lengths to size
classes; writer identity, timing, and row cadence remain visible, as the threat model states.
Padding costs at most 60 bytes on short values and ~12% on large ones. The 4-byte prefix caps a
single sealed payload at 4 GiB, far past engine limits. `unpadPayload` validates the declared length
but not the zero fill; the AEAD authenticates the whole padded plaintext, so fill tampering cannot
occur without failing authentication first.
