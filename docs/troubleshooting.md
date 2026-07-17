# Troubleshooting

Start with:

```sh
deno task doctor
```

The report names the blocked capability or configuration and gives a remediation without printing
environment values.

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

## Recovery does not restore a recent item

The phrase restores account authority, not unsynced device storage. Data returns only if it reached
managed sync before the original device was lost or cleared.
