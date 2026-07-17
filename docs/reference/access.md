# Account and access API

## Recoverable accounts

The root `@nzip/lofi` export owns principal replacement and runtime cleanup:

| API                                          | Purpose                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `readAccountSession()`                       | Opens the runtime and returns the stable `user_id` and account state.                 |
| `createRecoverablePasskeyBackup()`           | Backs up the active Jazz secret to a resident, user-verifying passkey.                |
| `restoreFromPasskey(options)`                | Restores that secret, saves it for the app ID, replaces the runtime, and elects sync. |
| `revealRecoveryPhrase()`                     | Returns the portable bearer-secret fallback. Do not persist or log it.                |
| `restoreFromRecoveryPhrase(phrase, options)` | Performs the same replacement lifecycle from the phrase.                              |

Both restore APIs require `confirmLocalReplacement: true` when a different local-only account would
be discarded. `RecoverablePasskeyError` maps unsupported browsers, cancellation, missing
credentials, RP-ID mismatch, and verification failure to non-secret, actionable messages.

`createBackupPasskey()` and `confirmPhraseAccess()` are retained compatibility APIs for a local
phrase-reveal guard. That credential cannot restore an account.

## Access templates

Import from `@nzip/lofi/access`:

- Schema helpers: `sharedGrantTable`, `groupMembershipTable`.
- Policy templates: `privateAccess`, `sharedAccess`, `groupAccess`, `defineAccessPolicies`.
- Identities: `sharingIdentity`, `encodeSharingIdentity`, `decodeSharingIdentity`.
- Operations: `createSharingOperations`, `createGroupOperations`.
- Fixed roles: `reader`, `contributor`, `writer`, `admin`.

Sharing operations provide `share`, `revoke`, `listShares`, and `sharedWithMe`. Group operations
provide `createGroup`, `addMember`, `changeRole`, `removeMember`, `leaveGroup`, and `listMembers`.
Collaboration operations reject local-only use with `AccessError.code === "sync-required"`.

In pinned Jazz alpha.53, the permission authority does not expose a group inserted earlier in the
same transaction to the first membership's `allowedTo.update("groupId")` check. `createGroup`
therefore serializes the creator-owned group write and first-admin membership write, and attempts a
compensating group delete if the membership is rejected. This is secure and leaves no usable
unadministered group in the tested path, but it is not database-transaction atomic. Do not describe
it as atomic until Jazz can validate that relationship against staged transaction rows.

The templates compile ordinary Jazz policies and accept a final raw-policy callback. They do not
replace `s.table`, `s.defineApp`, or raw `s.definePermissions`; use those directly when the fixed
models do not fit.
