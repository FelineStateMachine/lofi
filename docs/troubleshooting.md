# Troubleshooting

Start with:

```sh
deno task doctor
```

The report names the blocked capability or configuration and gives a remediation without printing
environment values.

## Doctor or build reports a PWA source blocker

Start with the first named file and action. The checks validate `public/manifest.webmanifest` as
JSON; require stable identity, names, same-origin launch scope, display mode, colors, and complete
icon roles; and inspect the dimensions and MIME types of local icons, shortcuts, and optional
screenshots. Asset filenames and branding are replaceable, and unknown optional manifest members
remain allowed.

If source checks pass but build reports `dist/`, do not hand-edit the output. Fix the author-owned
manifest, shell link, route, or asset, then rerun `deno task build`. The production check
deliberately treats HTML manifest links, the worker revision and scope, `lofi-build.json`, and
`lofi-precache.json` as one artifact so a partial or stale build cannot pass.

## The app says configuration is incomplete

Managed sync requires both public values:

```text
JAZZ_APP_ID
JAZZ_SERVER_URL
```

Set both, or remove both to run local-only. Do not move `JAZZ_ADMIN_SECRET` or `BACKEND_SECRET` into
client-visible variables.

If provisioning should replace an existing `.env`, review and back up the intended configuration,
then use the command's explicit `--force` option:

```sh
deno task jazz:provision --force
```

## Durable storage is blocked

lofi requires a secure context, OPFS, SharedWorker, Web Locks, and MessageChannel. It stops instead
of silently switching to memory-only data.

- Use a supported browser: Android Chrome 148+ or iOS Safari 16.4+.
- Use `localhost` during development or HTTPS on another device.
- Avoid embedded/private browser surfaces that disable required storage APIs.
- Treat clearing site data as destructive unless the account has synced and the recovery phrase is
  safe.

## Another tab is running an incompatible app version

Lofi stops persistent runtime startup when another tab for the same app is using an incompatible
browser broker configuration. This is reported as `broker-incompatible` in runtime diagnostics in
both local and managed mode.

1. Close every other tab or installed-app window for this app.
2. Return to the tab showing the recovery notice.
3. Select **Reload app** once.

The package does not take over the existing broker, fall back to memory, or automatically enter a
reload loop. Do not clear site data for this condition: closing the incompatible tabs and explicitly
reloading creates the clean document boundary the persistent driver requires.

## A task disappeared after changing app configuration

Check whether `databaseName` or the managed `JAZZ_APP_ID` changed. Both participate in the durable
storage namespace. Restoring the old values reopens the old namespace; copying rows between
namespaces is not automatic.

## Preview says the build is missing or stale

Run:

```sh
deno task build
deno task preview
```

Do not hand-create `dist/lofi-build.json`; it must describe the output produced by the build.

## The production build reports a secret leak

Remove the named server-only value from source, public files, logs, fixtures, and generated client
configuration. Rotate a real credential if it entered source control or an artifact, then rebuild.

## Browser tests skip or cannot launch

Set the base URL when running the opt-in example:

```sh
LOFI_E2E_BASE_URL=http://127.0.0.1:4321/ \
  deno test -A tests/convergence_e2e_test.ts
```

Install the pinned Chromium runtime if needed:

```sh
deno run -A npm:playwright@1.61.1 install chromium
```

## Local writes work but another device does not update

Check these states separately:

1. The deployment has a complete public Jazz pair.
2. The user explicitly elected to sync in `AccountGate`.
3. The latest write reached global durability rather than only local durability.
4. Both devices restored the same account identity.
5. The deployed schema and permissions allow the operation.

“Sync configured” is not proof that a specific user opted in or that a specific write reached the
server.

## A device with an enrolled ticket came back local-only

The declared sync location persists as a sealed record whose key lives in the browser's IndexedDB.
Clearing site data partially — IndexedDB without localStorage, or a browser "free up space" eviction
— leaves the record in place but unopenable, and the device deliberately falls back to local-only
rather than guessing. Local data is untouched. Re-enroll the ticket (paste it again) to declare the
sink and resume syncing under the same account.

## Recovery does not restore a recent item

The phrase restores account authority, not unsynced device storage. Data returns only if it reached
managed sync before the original device was lost or cleared.

## Passkey restore was cancelled or cannot find an account

- **Cancelled:** retry the user-verification prompt, or continue with the recovery phrase.
- **No recoverable passkey:** confirm the passkey exists in the active provider. A legacy
  phrase-reveal guard is not an account backup.
- **Different app hostname / RP-ID:** open the canonical production hostname used during backup.
- **Verification failed:** unlock the platform/password-manager authenticator and retry.
- **Unsupported browser/provider:** use the recovery phrase. Provider availability is not portable
  across every iOS, Android, browser, and password-manager combination.

The package maps these states without printing credential IDs, account secrets, or phrases.

## Sharing says managed sync is required

Private resources work local-only. Direct shares and groups require both a configured Jazz server
and the current account's explicit sync election. Back up and enable sync in `AccountGate`, then
retry. A configured deployment alone does not opt the current account into sync.
