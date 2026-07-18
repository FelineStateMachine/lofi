# Sealing the data sink at rest: slotted envelope with a capability split

Date: 2026-07-18\
Decision: adopt a multi-slot at-rest envelope with a silent device-key baseline; split sync and
provision capability tiers at rest; attempt PRF, never detect it; no-PRF fallback is memory-only
provision capability with password-manager custody

## Question

The enrolled app ticket's URL is a bearer credential (`/t/<secret>`), and for a provision-scoped
ticket, possession is store administration. How does it persist on a device so that nothing
bearer-shaped sits in storage in cleartext, without taxing every boot of a synced app with a passkey
ceremony — and what happens on devices whose authenticator cannot evaluate the WebAuthn PRF
extension?

## Contract IDs

No existing measurable promise covers at-rest credential custody; the affected documented semantics
are the ticket-bearer bullets in `docs/sync-and-recovery.md` and `docs/node/tickets-explained.md`.
The threat-model disclosure page (#122 §2) is where the claim set gets a permanent home.

## Exact versions

`@nzip/lofi` 0.5.0 working tree (#125); lofi-node `feat/scope-down-ticket-exchange`
(FelineStateMachine/lofi-node#4, commit 92a7877); WebCrypto AES-GCM/HKDF and IndexedDB as the
browser baseline; `jazz-tools@2.0.0-alpha.53` unchanged.

## Control

The pre-#125 behavior: the sink declaration, including the full ticket URL, stored as cleartext JSON
in `localStorage` under `lofi:data-sink:<anchorAppId>`.

## Decision

1. **Slotted envelope** (`package/runtime/envelope.ts`): a random 32-byte DEK encrypts the payload;
   the DEK is wrapped under one or more protector slots; the slot table and a purpose string are
   bound as authenticated data. Adding a protector re-wraps 32 bytes, never the payload — the
   property that later lets provision material gain a PRF slot, and field encryption change
   protectors, without re-encrypting data.
2. **Silent baseline, universally applied**: every sink record is sealed under a `device-key` slot —
   a non-extractable AES key in IndexedDB that opens with zero ceremony at boot. This defends the
   record at rest (disk images, backups, storage exfiltration). It deliberately does not defend
   against same-origin script, which can drive the silent open; that claim is never made.
3. **Capability split at rest**: sync-scope material opens silently forever (its theft is
   transport-only by the node gate's own scope enforcement); provision material is the tier that
   gets an interactive PRF gate. A single pasted provision ticket supports the split via the node's
   scope-down exchange (lofi-node#4): derive a parent-linked sync ticket, persist that silently,
   gate the provision original. Revoking the parent cascades.
4. **Attempt PRF, never detect it**: `getClientCapabilities` reports `not-reported` across most of
   the real matrix and PRF is a property of the authenticator, not the browser. Enrollment attempts
   the evaluation and records in the envelope what actually succeeded; the open path never consults
   a capability report.
5. **No-PRF fallback**: provision capability is not persisted at all — memory-only for the session,
   with ticket custody pushed to the user's password manager (the enrollment form is a
   `current-password` field with a label-as-username companion, so managers save on first paste and
   autofill later). The node stores only secret hashes, so mint time is the only time the ticket can
   enter the user's custody; the CLI says so.

Rejected alternatives: PRF-sealing the whole sink record (a passkey tap before every boot's
WebSocket, breaking ceremony-free boot for the common path); gating on the capability report (wrong
on most real devices); a passphrase slot as the default no-PRF fallback (envelope security becomes
the weakest slot, and password-manager custody yields gesture-gated persistence without a passphrase
UX to own); persisting the sync ticket in cleartext with a narrowed conformance check (the universal
envelope keeps one storage format and an unconditional no-plaintext-bearer assertion).

Rule that makes optimistic PRF safe to ship: only PRF-seal material that is recoverable out-of-band.
A deleted passkey or an uncooperative authenticator means re-enrollment, never data loss.

## Procedure

`deno task test` (envelope and data-sink suites), `deno task check`, `deno task build`,
`deno task test:golden`. The conformance check enrolls a provision-scoped ticket and scans every
stored value for the secret and URL in cleartext, base64, base64url, and URL-encoding, then asserts
the record parses as a v1 envelope and restores to the exact ticket.

## Evidence

`package/runtime/envelope_test.ts` (multi-slot open, fall-through, tamper → corrupt, purpose
binding, strict validation) and `package/runtime/data-sink_test.ts` (sealed round-trip, cleartext
migration, unopenable-not-destroyed, no-plaintext-bearer scan). Golden suite passes through the
boot-time restore. lofi-node#4 carries the exchange and cascade tests.

## Contract delta

The stored declaration is no longer cleartext; declaration APIs (`declareDataSink`,
`declareSinkFromTicket`) became asynchronous; a sealed record whose device key is gone reports
`unopenable`, leaves the record intact, and the device runs local-only until re-enrollment
(`docs/troubleshooting.md`). The XSS posture is unchanged in phase 1 and documented as such.

## Follow-up

PRF slot wiring, the enrollment exchange flow, and password-manager custody UX landed as A3 phase 2
(`provision.ts`, `authenticateAndDerivePrfSecret`, `TicketEnrollForm`); field encryption is scoped
in #126 with the account-private/group-shared split; claim alignment continues in #122 §2 and §4.
