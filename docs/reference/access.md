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

- Schema helpers: `sharedGrantTable`, `groupMembershipTable`, `sharedFieldDirectoryTable`,
  `sharedFieldKeyTable`.
- Policy templates: `privateAccess`, `sharedAccess`, `groupAccess`, `sharedFieldAccess`,
  `defineAccessPolicies`.
- Identities: `sharingIdentity`, `encodeSharingIdentity`, `decodeSharingIdentity`.
- Operations: `createSharingOperations`, `createGroupOperations` (configured with
  `SharingOperationsConfig` and `GroupOperationsConfig`).
- Errors: `AccessError`/`isAccessError` and `SharedFieldError`/`isSharedFieldError`, the two
  catchable families of group and sharing operations.
- Pin remediation: `trustPeerKey`, the explicit re-trust that resolves a `peer-key-changed` refusal
  (also on the root `@nzip/lofi` export, next to `pinnedFingerprint`).
- Fixed roles: `reader`, `contributor`, `writer`, `admin` (exposed as `groupRoles`, with the
  role-to-capability mapping in `groupRoleCapabilities`).

Sharing operations provide `share`, `revoke`, `listShares`, and `sharedWithMe`. Group operations
provide `createGroup`, `addMember`, `changeRole`, `removeMember`, `leaveGroup`, `listMembers`, and
`reconcileSharedFieldKeys`. Collaboration operations reject local-only use with
`AccessError.code === "sync-required"`.

## Shared encrypted fields

Columns declared with `s.sharedEncryptedText` and `s.sharedEncryptedJson` (from `@nzip/lofi/schema`)
hold ciphertext readable by every current group member. The access side hosts the key material:
`sharedFieldDirectoryTable` and `sharedFieldKeyTable` store the directory and per-member wrapped
keys, `sharedFieldAccess` (or the `fieldKeys` option of `groupAccess`) compiles their policies, and
group operations created with the same `fieldKeys`/`directory` tables mint, wrap, and rotate group
field keys automatically: `createGroup` bootstraps the first key, `addMember` delivers held
generations, `removeMember` rotates, and `reconcileSharedFieldKeys` repairs missing wraps. Key
failures raise `SharedFieldError` (narrow with `isSharedFieldError`). Rotation is lazy: removing a
member re-keys future writes, while content encrypted under generations the member already holds
remains readable to them. See [Permission templates](../permissions.md) for the hosting walkthrough.

In pinned Jazz alpha.53, the permission authority does not expose a group inserted earlier in the
same transaction to the first membership's `allowedTo.update("groupId")` check. `createGroup`
therefore serializes the creator-owned group write and first-admin membership write, and attempts a
compensating group delete if the membership is rejected. The compensating delete is authorized by
the creator's direct delete authority on their own group rows, so a failed bootstrap does not strand
an orphan group. This is secure, but it is not database-transaction atomic. Do not describe it as
atomic until Jazz can validate that relationship against staged transaction rows.

The group creator additionally holds a permanent superseat — see
[Permission templates](../permissions.md#fixed-group-roles) and
[the decision record](../decisions/group-creator-authority-alpha53.md).

The templates compile ordinary Jazz policies and accept a final raw-policy callback. They do not
replace `s.table`, `s.defineApp`, or raw `s.definePermissions`; use those directly when the fixed
models do not fit.
