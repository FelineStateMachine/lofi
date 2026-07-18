# Jazz `BrowserPasskeyBackup` security review

Date: 2026-07-17\
Reviewed dependency: `jazz-tools@2.0.0-alpha.53`\
Decision: retain the pin for Wave 2

## Contract reviewed

The current Jazz local-first-auth documentation describes `jazz-tools/passkey-backup` as a
browser-only, encrypted-at-rest vault for the same 32-byte local-first secret used by
`BrowserAuthSecretStore`. Restore must return that secret after a user-verifying WebAuthn ceremony;
the live Jazz client must then be replaced. The recovery phrase remains the portable bearer-secret
fallback.

The exact installed implementation was reviewed at
`jazz-tools/2.0.0-alpha.53/dist/runtime/passkey-backup.js` and its packaged tests, not inferred from
a newer release.

| Assumption          | Exact alpha.53 behavior                                                                                                                                                                                      | Lofi boundary                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At-rest protection  | The 32-byte secret is supplied as the resident credential user handle. It is released by `credentials.get()` after the authenticator assertion; Jazz does not add application-level wrapping.                | We rely on the browser/platform passkey provider to protect credential material at rest. We do not claim lofi controls or can audit provider encryption.                                                                    |
| RP-ID               | `appHostname` becomes both `rp.id` during backup and `rpId` during restore.                                                                                                                                  | Production apps should pin one canonical hostname. A changed or preview hostname cannot see the old passkey and is reported as an RP-ID mismatch when the browser exposes that distinction.                                 |
| Resident credential | `residentKey: "required"` and `requireResidentKey: true`. Restore uses discoverable lookup without an allow-list.                                                                                            | A non-resident authenticator does not satisfy the contract.                                                                                                                                                                 |
| User verification   | Backup requests `userVerification: "required"` and `credentialProtectionPolicy: "userVerificationRequired"`. Restore again requires verification and checks both UP and UV bits before reading `userHandle`. | Cancellation and failed verification are non-secret, retryable UI errors. Lofi never treats credential presence alone as authority.                                                                                         |
| Provider sync       | The implementation requests `authenticatorAttachment: "platform"`; whether the passkey roams is decided by the OS/browser/provider.                                                                          | Same-provider recovery is expected where that provider syncs passkeys. Universal iOS/Android/browser/provider portability is not promised. Cross-device QR flows may require the original device and are not loss recovery. |

## Decision

Alpha.53 implements the documented resident, RP-scoped, user-verifying secret round trip and its
packaged tests cover secret length, credential options, RP-ID, UP/UV enforcement, invalid handles,
and round-trip restore. No dependency upgrade is required for the reviewed contract.

Lofi exposes this as a **recoverable account backup**, distinct from its earlier **guard-only
credential**. The earlier credential proves user presence before showing a locally stored recovery
phrase; it does not contain the Jazz secret and cannot restore an account. Existing guard-only
credentials remain usable for phrase reveal but are labeled as legacy/local and never presented as
account backups.

## Trust and fallback

- The passkey provider and browser are trusted to protect and, where supported, sync the resident
  credential.
- The canonical RP-ID is part of the recovery boundary and must remain stable.
- The recovery phrase is the portable fallback. It is the account secret encoded as words; anyone
  holding it can act as the account.
- Restoring a different secret requires explicit confirmation while the current account is
  local-only, because unsynced local rows cannot be recovered from Jazz sync.
- Principal replacement detaches lofi stores/subscriptions and shuts down the old Jazz client and
  workers via `db.shutdown()` — deliberately not `logout()`, which would clear local account state
  that must carry forward. It then saves the restored secret for the app ID, commits the sync
  election and managed-namespace record only after that save succeeds (a failed replacement leaves
  the previous local account bootable), reopens the runtime on the restored principal, and exposes
  the restored `session.user_id` for verification.

## Evidence sources

- Jazz, “Local-first auth”: <https://jazz.tools/docs/auth/local-first-auth>
- Jazz, “Lifecycle”: <https://jazz.tools/docs/auth/lifecycle>
- Pinned package source and tests in the resolved Deno npm cache for `jazz-tools@2.0.0-alpha.53`
