# What the sync server can see

A lofi app is local-first: without sync, everything lives on the device and this page is moot. The
moment an account syncs — to a managed deployment or to a self-hosted node — a server holds a copy
of the data. This page states plainly what that server can and cannot do with it, what the user
holds that the server never does, and which of those lines move as the encryption surface grows.

## The server's view

The pinned data layer (Jazz 2) uses a trusted-server model: the sync server materializes table
state, evaluates permission policies, and serves queries. Three consequences follow.

- **Ordinary column values are readable by the store operator.** Permissions bound which
  _identities_ may read or write rows; they do not hide data from the server that enforces them.
- **Structure and metadata are always visible**: which tables exist, row identities, who wrote,
  when, and how much. This holds even for encrypted columns.
- **Choosing the operator is a real security decision.** Self-hosting (a
  [lofi-node](https://lofi.host/node)) does not make the server blind; it makes the reader _you_.
  "Your server reads your data" and "someone else's server reads your data" are different threat
  models, and lofi treats the choice of sync location as user data, not developer configuration.

## What the user holds

- **The account identity secret.** Accounts are device-local and cryptographic; there is no
  server-side account to reset or impersonate. The server never holds recoverable account material.
- **Recovery material**: the recovery phrase, and optionally a recoverable passkey. Losing both
  loses the account; no operator can restore it, which is the honest half of holding the keys.
- **The sync location**, enrolled by ticket and revocable at the node.
- **Sealed local state.** Nothing bearer-shaped sits in browser storage in cleartext: the sync
  declaration persists as an envelope under a device-bound key, and store-administration capability
  is either sealed behind the user's passkey or never persisted at all.

## Encrypted columns: content the server cannot read

Fields declared with `s.encryptedText`, `s.encryptedJson`, `s.encryptedNumber`, or `s.encryptedDate`
are sealed on the client before they enter Jazz. The key derives from the account secret, so every
device holding the account decrypts and nobody else can, including the store operator. Plaintext is
padded to bucketed sizes before sealing, so for those fields the server's view degrades to "rows of
a certain size class and cadence exist" — all short values share one class, and larger values reveal
only a coarse bucket.

The constraints are mechanical, not policy, and enforced: a `where` on an encrypted column is a
compile error and a permission policy referencing one fails configuration, because the server cannot
evaluate what it cannot read; filtering on decrypted values runs client-side instead. An encrypted
column is account-private — a row shared with another account is undecryptable for them by design,
and reads refuse loudly rather than return garbage. Details:
[encrypted columns](data-and-ui.md#encrypted-columns).

## Shared fields: content the server relays but cannot read

Shared encrypted columns extend sealing to group collaboration: a per-group field key seals the
content, and the key itself travels as ordinary synced data — wrapped to each member's public key,
which every account self-publishes in a key directory. The wrap is authenticated with the sender's
own key, so a server that knows every public key still cannot mint one; forging a wrap requires a
member's secret.

For shared fields the server is therefore an **active attacker, not a passive reader**: its one move
is substituting public keys during membership changes, and that move is detected. Each device pins
peer keys on first sight, sharing identities carry the account's key fingerprint so members added
person-to-person are pinned with no server first-sight window, and a key that later disagrees is
refused — the field stays sealed and the mismatch surfaces as an alert, until the user re-trusts
after out-of-band verification.

The residual exposures, stated plainly: a peer first seen only through the directory is trusted on
first sight by that device; a removed member keeps the key generations they already held (removal
seals future content, not history — re-encrypting merged history is unsound); and structure, timing,
and size-class metadata remain visible exactly as for account-private fields. Details:
[shared encrypted columns](data-and-ui.md#shared-encrypted-columns).

## Tickets: what possession grants

An app-connect ticket is a bearer credential with 256-bit entropy.

- A **sync-scoped** ticket is transport capability. Holding one allows connecting and syncing as the
  store's transport layer permits; reading data still requires an identity the permissions admit.
  Revocation is one command at the node and closes live connections within seconds.
- A **provision-scoped** ticket is store administration by possession. The app therefore refuses to
  hold one loosely: on enrollment it is exchanged for a derived sync ticket (which becomes the
  everyday transport credential and dies with its parent on revocation), and the provision original
  is sealed behind the user's passkey or kept only in memory, with the user's password manager as
  the durable copy.
- The **derived sync ticket is possession-bound in use** against a node that supports the exchange:
  enrollment offers a non-extractable device key, and connecting thereafter means answering a fresh
  challenge with a signature only that device can produce. The everyday credential then stops being
  a pure bearer string — a copy lifted from a backup, a log line, or a pasted URL no longer connects
  from anywhere else. Losing the device key (a wiped browser store) is deliberately unrecoverable;
  re-enrolling a fresh ticket is the recovery.

**Same-origin script (XSS) is the attacker this custody is shaped around.** Script running on the
app's origin can use whatever the page can use: the page's own device key answers the challenge for
whatever runs inside it, so a compromised origin holds transport capability while its page is live.
Possession binding narrows what that compromise is worth — the credential material script can read
no longer connects from anywhere else, because the signing key cannot leave the device. Exfiltration
loses its value; in-page abuse remains, and the Content-Security-Policy below is the control aimed
at that residue. What script cannot do silently is obtain admin capability — unlocking sealed
provision material is a user-verifying passkey prompt, so theft degrades from silent to prompted,
and a prompt the user did not initiate is the signal to decline. At-rest theft (disk images,
backups, storage exfiltration) gets the stronger guarantee: sealed records are ciphertext without
the device key or the passkey, and the sync credential inside them is bound to a key that was never
in the record at all.

Generated apps also narrow the surface that creates same-origin script in the first place: every
built page carries a Content-Security-Policy that admits only the app's own hashed scripts — no
remote script origins, no inline execution beyond the hashed island bootstraps. The build reports
the policy and warns on weakenings; `LOFI_CSP=off` and the extension points are documented in the
deployment guide. A compromised dependency or injected markup then fails to execute rather than
inheriting the page's capability.

## Where the lines move

- **Engine-authenticated member keys** would upgrade the shared-field trust story: today's key
  directory is self-published and pinned; identity material the sync engine itself authenticates
  would remove the first-sight window entirely. Tracked against the pinned engine and reviewed on
  every version bump.
- **Metadata blindness is out of scope** under the pinned engine: a server that evaluates policies
  and queries must see structure. A fully blind relay is a different architecture and is not
  claimed.

Read this page as the definition behind the phrase "the user holds the keys": identity, recovery,
location, and at-rest custody, with content blindness per field where the schema declares it —
account-private or shared across a group.
