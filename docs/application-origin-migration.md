# Application-origin migration

Changing a production app from one origin to another creates a new browser security boundary. An
HTTPS redirect moves navigation; it does not move the old origin's service workers, Cache Storage,
IndexedDB, OPFS, permissions, installed-app identity, or WebAuthn credentials.

This playbook keeps the old origin available while each user deliberately restores account access or
imports a product-owned export, verifies the new origin, and only then removes the old installation.
It never copies account secrets, passkeys, opaque IndexedDB/OPFS files, or browser permission state.

## Choose the migration contract

Record these decisions before deploying the new origin:

| Decision                | Required choice                                                                  |
| ----------------------- | -------------------------------------------------------------------------------- |
| Old-origin availability | A dated compatibility window long enough for offline users to return             |
| Data path               | Managed account sync/recovery, or a versioned product-owned export/import format |
| Manifest identity       | A deliberate new same-origin `id`, `start_url`, and `scope`                      |
| Credentials             | New stable hostname/RP ID and a new-origin enrollment/recovery ceremony          |
| Install UX              | Whether old and new installations coexist and how each is labeled                |
| Retirement              | Warning dates, final read-only date, rollback owner, and support path            |

Do not silently add the new hostname to `credentialOrigins`. A WebAuthn credential is scoped by its
RP ID and origin checks; changing the permanent hostname is an identity decision, not a redirect
configuration detail. Keep lofi's checks intact and require an explicit new-origin recovery or
enrollment flow.

## Pick one data path

### Managed account sync and recovery

1. On the old origin, reconnect and wait until the UI reports global durability for the latest
   write.
2. Make sure the user has a portable recovery phrase. An old-origin passkey alone cannot establish
   the same RP ID on a different hostname.
3. Open the new origin directly, create its fresh local browser storage, and restore the account
   with the supported recovery ceremony.
4. Wait for synced data to appear, then compare representative counts and named records.
5. Make a harmless test edit on the new origin and verify global durability and another-client
   convergence before treating the migration as complete.

Never put an account secret, recovery phrase, or serialized Jazz/browser database in a URL,
redirect, query parameter, cross-origin message, analytics event, or support log.

### Product-owned export and import

1. Export only a documented product schema from the old origin. Version it, bound its size, and omit
   credentials, opaque storage records, cache entries, handles, and permission grants.
2. On the new origin, validate the file as external input and show an import preview.
3. Require explicit confirmation before writing it to the new local database.
4. Compare representative counts and records, reload, go offline, and verify the imported data
   again.
5. Preserve the export until the compatibility window closes.

The [file handling recipe](recipes/file-handler.md) provides a preview-only validation boundary, but
an ordinary file picker remains the portable migration path.

## Deployment sequence

1. Deploy the new origin with its own manifest identity, icons, worker scope, database name, and
   stable credential-origin configuration.
2. Keep the old origin's application shell, worker assets, recovery/export UI, and support page
   available. Do not blanket-redirect these paths during the compatibility window.
3. Add old-origin messaging that links to the exact new HTTPS origin and explains that local data
   and permissions do not move automatically.
4. Let both installations coexist. Give the new installation distinct temporary labeling if the OS
   would otherwise make them ambiguous.
5. Ask for notifications, storage persistence, file/protocol associations, and other permissions
   again only when the user reaches the relevant new-origin feature.
6. After user verification, offer instructions to uninstall the old app. Never uninstall it or clear
   its storage programmatically as part of migration.

## Repeatable verification checklist

Run this with a clean browser profile and with a profile containing representative production-like
data. Retain dates and non-secret results with the release evidence.

- [ ] `ORIGIN-01` Old origin opens online and offline with its retained worker/app shell.
- [ ] `ORIGIN-02` New origin installs with the intended new manifest ID, scope, and display name.
- [ ] `ORIGIN-03` New origin starts with separate IndexedDB, OPFS, Cache Storage, and permissions.
- [ ] `ORIGIN-04` Chosen sync/recovery or export/import path transfers only product-owned data.
- [ ] `ORIGIN-05` Representative counts and named records match before the old app is removed.
- [ ] `ORIGIN-06` Reload and offline restart preserve verified data on the new origin.
- [ ] `ORIGIN-07` A new-origin edit reaches its required durability and convergence state.
- [ ] `ORIGIN-08` Old passkey behavior is rejected honestly; new recovery/enrollment succeeds.
- [ ] `ORIGIN-09` Permissions and OS associations are requested or registered afresh as documented.
- [ ] `ORIGIN-10` Old and new installations are distinguishable while they coexist.
- [ ] `ORIGIN-11` Offline users returning during the window still receive migration instructions.
- [ ] `ORIGIN-12` No secret or opaque browser-storage value appears in URLs, logs, or artifacts.

## Partial migration and rollback

Migration is per user and per device. Track `not started`, `restored/imported`, `verified`, and
`old installation removed` separately; never infer completion from a redirect or a visit.

If verification fails, stop new-origin writes when practical, keep the old origin authoritative, and
preserve the user's export/recovery material. Fix the new deployment or importer, then repeat from a
fresh new-origin profile. Do not merge divergent local datasets automatically unless the product has
a tested domain-level reconciliation strategy.

Delay retirement when offline users have not had a reasonable return window, recovery/export remains
broken, or support cannot distinguish partial states. At retirement, keep a minimal non-sensitive
status/support page for the announced period, revoke old deploy credentials, and retain rollback
artifacts. Removing DNS or the old worker too early strands users whose only current copy is local.
