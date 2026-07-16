# Local-first accounts: open now, back up later

lofi's identity model is **local-first**. A new app opens immediately on a private, on-device
account — no sign-in, no ceremony, nothing sent anywhere. From there the user can _elect_ to back up
and sync that account, and recover it on another device. Electing to sync preserves everything
created while local-only, because the account identity never changes.

This is the pit of success: the app works the instant it loads, and the path to a durable,
multi-device account is one opt-in click — not a wall the user hits before they can do anything.

## The three states

1. **Local-only (first boot).** The runtime opens a random per-device account
   (`BrowserAuthSecretStore.getOrCreateSecret`) and never waits. Writes are durable on the device;
   nothing reaches the network. This is the whole experience for a purely local app.
2. **Backed up & syncing (elected).** When a managed Jazz app is configured, the user elects to back
   up and sync. Replication turns on, the existing local data pushes up under the _same_ identity,
   and a recovery phrase becomes available.
3. **Recovered (on another device).** Entering the recovery phrase reconstructs the exact account
   secret, so the account — and the data that synced up — comes back down.

The **AccountGate** island (`src/islands/AccountGate.tsx`) drives states 2 and 3. It renders only
when a Jazz app is configured, because a recovery phrase only matters once there is somewhere to
sync to.

## How the account survives the upgrade

A lofi account _is_ a 32-byte secret. The Jazz account id is a function of that secret, so the same
secret always opens the same account — whether or not a sync server is attached:

```
local-only:  createDb({ appId, secret })                 → account X, on this device
synced:      createDb({ appId, secret, serverUrl })      → account X, now replicated
```

Electing to sync just recreates the runtime with `serverUrl` added. Because the secret (and thus the
account id) is unchanged, every write made while local-only is already part of account X and syncs
up. No migration, no copy, no new account.

## The recovery phrase is the portable backup

The same 32-byte secret encodes as a 24-word recovery phrase (`RecoveryPhrase.fromSecret` /
`.toSecret`, via `jazz-tools/passphrase`):

```
recovery phrase = words( account secret )      # the phrase *is* the account
```

- **Back up** → create a passkey, then reveal the phrase once and write it down. It is the exact
  same account, offline and portable.
- **Recover** → type the phrase on any device → the same secret → the same account → its synced data
  flows back down, decrypted (Jazz E2E-encrypts synced data keyed on the account).

Restoring replaces whatever account the device currently holds, so the UI confirms before discarding
a local-only account's un-backed-up data.

### Passkey confirmation on reveal

Backing up enrols a passkey (`enrollDeviceCredential`), and revealing the phrase afterwards runs a
user-verifying passkey ceremony (`confirmPhraseAccess`) — so the recovery phrase, a bearer secret,
is not handed out without confirming the person is present. Stated honestly: this is a
**confirmation**, not encryption. The account secret still lives in device storage so the app can
open instantly; the passkey does not encrypt it. A device where WebAuthn is unavailable can still
back up, and the UI says the reveal was unconfirmed. (For real at-rest encryption of the secret, the
PRF primitive in `src/_lofi/auth.ts` is available — see below.)

### Boot flow

- **First boot** → local-only account opens immediately. No gate.
- **Back up & sync** (a click) → create a passkey → reveal the recovery phrase to save → turn on
  sync → the runtime recreates and the account replicates.
- **Return boots** → the same cached secret opens the same account, synced or not.
- **A new device** → restore from the recovery phrase → the account and its synced data appear.
- **Stop syncing** → detaches the network and returns to local-only; the account and data are
  untouched, and electing again resumes against the same account.

The framework side lives in `src/_lofi/session.ts` (`readSession`, `createBackupPasskey`,
`confirmPhraseAccess`, `revealRecoveryPhrase`, `enableSyncBackup`, `stopSyncBackup`,
`restoreFromRecoveryPhrase`); the gate is the author-owned example you can restyle or replace.

## Custody and recovery — stated plainly

- **No recovery service.** lofi never holds recoverable account material. Recovery is the recovery
  phrase, held by the user. Sync replicates data to the managed Jazz app under an account only the
  key can open.
- **Lose every copy of the phrase _and_ the device → lose the account.** That is the honest cost of
  no-central-custody.
- **This is not a server-assisted account-backup ceremony.** The account is a local-first secret the
  user backs up themselves; nothing on the server can reconstruct it.

## Provisioning sync

A managed Jazz app supplies `JAZZ_APP_ID` / `JAZZ_SERVER_URL` (the public pair the runtime reads)
plus server-only secrets. Generate one and write `.env` in one step:

```sh
deno task jazz:provision                            # existing project
deno run -A jsr:@nzip/lofi/create --sync my-app     # at scaffold time
```

The generated app is unclaimed — claim it from the Jazz dashboard within the grace window shown, or
it expires. `.env` holds the server-only secrets and is git-ignored.

## Optional: protecting the secret at rest

`src/_lofi/auth.ts` is a standalone device-credential primitive: enroll a WebAuthn passkey and
derive a credential-bound key (PRF) to encrypt data — including the account secret — **at rest**. It
is feature-detected and never faked. It is _not_ the account identity (deriving the account from a
credential was removed, since a derived key is a different account and cannot carry local-only data
forward). See [docs/auth.md](auth.md).
