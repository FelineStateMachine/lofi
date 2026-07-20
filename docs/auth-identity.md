# Local-first accounts: open now, back up later

This document explains the account and custody model. For project setup and a shipping checklist,
see [Sync and recovery](sync-and-recovery.md).

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
3. **Recovered (in a fresh browser).** A recoverable passkey or the recovery phrase reconstructs the
   exact account secret. The old runtime is shut down, the new principal is opened with sync, and
   data that reached the sync provider flows back down.

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

Electing to sync recreates the runtime with `serverUrl` added. Because the secret (and thus the
account id) is unchanged, every write made while local-only still belongs to account X — no new
account, and nothing for the user to re-enter. Internally, the election is one durable record: lofi
opens the account's managed namespace, copies the rows written while local-only into it (waiting
only for local durability, so the copy also completes offline), and replicates them up through
normal sync once connected.

## The recovery phrase is the portable backup

The same 32-byte secret encodes as a 24-word recovery phrase (`RecoveryPhrase.fromSecret` /
`.toSecret`, via `jazz-tools/passphrase`):

```
recovery phrase = words( account secret )      # the phrase *is* the account
```

- **Back up** → create a recoverable passkey and reveal the phrase once. Both represent the exact
  same account secret.
- **Recover with a passkey** → the browser/provider releases the resident credential's secret after
  user verification → the same account opens.
- **Recover with the phrase** → type the words on a compatible device → the same account opens. The
  phrase is the portable bearer-secret fallback and does not depend on a passkey provider.

Restoring replaces whatever account the device currently holds, so the UI confirms before discarding
a local-only account's un-backed-up data.

### Two passkey credentials with different jobs

`createRecoverablePasskeyBackup` uses Jazz's passkey-backup implementation to place the 32-byte
account secret in a resident, user-verifying platform credential. `restoreFromPasskey` can recover
the account from that credential. Availability follows the configured RP-ID and the browser,
operating system, and passkey provider; lofi does not promise universal cross-provider or
cross-platform portability.

The older `createBackupPasskey` API is different: it enrolls a credential that only confirms a later
`confirmPhraseAccess` ceremony on the same browser. It does not contain a recoverable account
backup. The reference UI labels it a **local phrase-reveal guard** so the two credentials cannot be
confused.

### Boot flow

- **First boot** → local-only account opens immediately. No gate.
- **Back up & sync** → create a recoverable passkey when supported → reveal the recovery phrase to
  save → the user confirms the phrase is saved → sync turns on and the runtime recreates (a page
  reload), and the account replicates. Sync is never enabled while the phrase is still unread.
- **Return boots** → the same cached secret opens the same account, synced or not.
- **A fresh browser** → explicitly confirm replacement → restore from passkey or phrase → the old
  subscriptions, stores, workers, cached clients, and Jazz client shut down → the restored account
  starts and synced rows can arrive.
- **Stop syncing** → detaches the network and returns to local-only; the account and data are
  untouched, and electing again resumes against the same account. Stopping also releases the
  device's sync-owner pin, so a different account may elect sync on this device afterwards.
- **A different account over an existing election** → the runtime refuses to connect: sync on a
  device is pinned to the account that elected it, so a restored identity (or a reset browser store
  that minted a fresh account) boots local-only with `session.syncOwnerMismatch` set instead of
  writing into the owner's store. Stop syncing or restore the owning account to proceed.

The framework side is exported by `@nzip/lofi` (`readAccountSession`,
`createRecoverablePasskeyBackup`, `restoreFromPasskey`, `revealRecoveryPhrase`, `enableSyncBackup`,
`stopSyncBackup`, `restoreFromRecoveryPhrase`). The gate is the author-owned example you can restyle
or replace.

## Custody and recovery — stated plainly

- **lofi does not run a recovery service.** The user holds the phrase; a recoverable passkey is held
  by the browser/platform provider. The Jazz sync service cannot reconstruct the account secret.
- **Provider sync has boundaries.** A passkey may sync inside one provider ecosystem, but RP-ID,
  account, browser, operating-system, and provider rules decide availability. Keep the phrase.
- **Lose every secret-bearing device, recoverable passkey, and phrase → lose the account.** Synced
  ciphertext alone does not restore identity authority.

The exact pinned dependency audit and trust assumptions are retained in
[the passkey decision record](decisions/passkey-backup-alpha53.md).

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

The package auth runtime is a standalone device-credential primitive: enroll a WebAuthn passkey and
derive a credential-bound key (PRF) to encrypt data — including the account secret — **at rest**. It
is feature-detected and never faked. It is _not_ the account identity (deriving the account from a
credential was removed, since a derived key is a different account and cannot carry local-only data
forward). See [Advanced device auth](auth.md).
