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

The constraints are mechanical, not policy: an encrypted column cannot be a filter or permission
target, because the server cannot evaluate what it cannot read; and it is account-private — a row
shared with another account is undecryptable for them by design, and reads refuse loudly rather than
return garbage. Details: [encrypted columns](data-and-ui.md#encrypted-columns).

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

**Same-origin script (XSS) is the attacker this custody is shaped around.** Script running on the
app's origin can use whatever the page can use: it can drive the silent open of the sync
declaration, so a compromised origin leaks transport capability. What it cannot do silently is
obtain admin capability — unlocking sealed provision material is a user-verifying passkey prompt, so
theft degrades from silent to prompted, and a prompt the user did not initiate is the signal to
decline. At-rest theft (disk images, backups, storage exfiltration) gets the stronger guarantee:
sealed records are ciphertext without the device key or the passkey.

## Where the lines move

- **Shared-field encryption** is the designed next step: distributing a field key wrapped to each
  member's account key, stored as ordinary synced data the server cannot open. That demotes the
  server from passive reader to active attacker for shared fields — it could only attempt key
  substitution during membership changes, a detectable act rather than silent reading.
- **Metadata blindness is out of scope** under the pinned engine: a server that evaluates policies
  and queries must see structure. A fully blind relay is a different architecture and is not
  claimed.

Read this page as the definition behind the phrase "the user holds the keys": identity, recovery,
location, and at-rest custody today, with content blindness per field where the schema declares it.
