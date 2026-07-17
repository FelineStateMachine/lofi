# Configuration reference

## Application configuration

`src/app.ts` is author-owned:

| Field               | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `name`              | Human-facing application name                                        |
| `databaseName`      | Prefix for the durable local database namespace                      |
| `schema`            | Typed application schema exported by `src/schema.ts`                 |
| `storage`           | Durable storage policy; generated projects use `"durable"`           |
| `credentialOrigins` | Stable hostnames allowed for optional WebAuthn/device-credential use |
| `passkey.rpId`      | Canonical production hostname for recoverable account passkeys       |
| `sync.adapter`      | Generated sync adapter selection                                     |
| `repositoryUrl`     | Source/home link displayed by the starter                            |

Choose `databaseName` and stable credential origins before shipping. Changing them later can change
which local database or WebAuthn relying party the browser opens.

Omitting `passkey.rpId` uses `location.hostname`. That is useful in local development, but each
preview hostname becomes a separate passkey namespace. Pin the stable production RP-ID before
offering passkey backup to real users.

## Environment configuration

| Name                | Classification | Behavior                                  |
| ------------------- | -------------- | ----------------------------------------- |
| `LOFI_BASE_PATH`    | Public build   | Mount path; defaults to `/`               |
| `JAZZ_APP_ID`       | Client-visible | Selects the managed Jazz application      |
| `JAZZ_SERVER_URL`   | Client-visible | Selects its sync endpoint                 |
| `JAZZ_ADMIN_SECRET` | Server-only    | Used by schema and administrative tooling |
| `BACKEND_SECRET`    | Server-only    | Reserved for server-side integration      |

No `.env` selects local-only mode. A complete `JAZZ_APP_ID` and `JAZZ_SERVER_URL` pair makes sync
available. A partial pair is invalid and blocks affected commands.

Process environment values take precedence over `.env`. Server-only values must never be prefixed as
public variables, imported into client code, or committed.

## Build-time behavior

The app is static, so public Jazz configuration is projected into the client during development or
build. Changing the deployment environment requires a new production build.
