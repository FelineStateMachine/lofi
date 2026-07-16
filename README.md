# @nzip/lofi

**A local-first mobile PWA meta-framework for Deno.** Declare a schema, build Preact islands, ship
an installable offline-capable app. The UI always hydrates from local data, identity never waits on
a server, and the sync module is the only network surface you touch.

Built on [Jazz 2](https://jazz.tools) (CRDT data + sync) · [Preact](https://preactjs.com) islands in
[Astro](https://astro.build) · the [Deno](https://deno.com) toolchain.

## Quick start

```sh
deno run -A jsr:@nzip/lofi/create my-app
cd my-app
deno task dev
```

That's the whole onboarding. You now have an installable, offline-capable local-first PWA — make a
write, reload it, go offline, and the UI keeps working because it reads from durable local storage,
not the network.

Want sync and account backup from the start? Scaffold with `--sync`:

```sh
deno run -A jsr:@nzip/lofi/create --sync my-app
```

It provisions a managed Jazz app and writes the project's `.env`, so the app can offer synced,
recoverable accounts immediately.

> Requires **Deno 2.9+**, the only global runtime. With no `.env` the app runs local-only (stated
> explicitly at boot). For managed sync + backup, run `deno task jazz:provision` (or scaffold with
> `create --sync`) to generate a Jazz app and write the `.env` — or set the public `JAZZ_APP_ID` /
> `JAZZ_SERVER_URL` pair by hand. Server-only secrets never reach client output.

## What a generated project looks like

A new project is split into two zones — what you own, and the runtime you don't touch:

```text
my-app/
├── deno.json              # tasks + pinned toolchain
├── astro.config.ts
├── public/                # manifest, service worker, icons
├── src/
│   ├── schema.ts          # ← your data model
│   ├── permissions.ts     # ← your access policy
│   ├── app.ts             # ← your app configuration
│   ├── pages/             # ← your Astro shell
│   ├── islands/           # ← your Preact UI (starts as a minimal task list to replace)
│   ├── styles/
│   └── _lofi/             # runtime: storage, identity, sync, lifecycle, diagnostics — don't edit
└── tests/                 # your tests + the @nzip/lofi/testing contract
```

You write `schema.ts`, `permissions.ts`, islands, and styles. Everything under `src/_lofi/` is the
framework runtime; product work never needs to touch it.

## Commands

Every generated project ships this task surface (`deno task <name>`):

| Command                                 | What it does                                                  |
| --------------------------------------- | ------------------------------------------------------------- |
| `dev`                                   | Astro dev server; prints storage, identity, and sync state.   |
| `doctor`                                | Value-free readiness report — no secrets, no faked claims.    |
| `test`                                  | Deterministic local-first tests (no hand-timed sleeps).       |
| `build`                                 | Static production build into `dist/`.                         |
| `preview`                               | Serves the production build locally.                          |
| `deploy` / `deploy:create`              | Host the static build on Deno Deploy.                         |
| `jazz:provision`                        | Generate a managed Jazz app and write `.env` for sync/backup. |
| `schema:validate` / `schema:deploy`     | Validate and publish your Jazz schema.                        |
| `migrations:create` / `migrations:push` | Author and push schema migrations.                            |

## Testing local-first behavior

`@nzip/lofi/testing` provides Playwright-backed helpers for the parts that are genuinely hard to
test — offline and multi-client behavior: a two-client fixture, concurrent-offline convergence,
readiness waits without arbitrary sleeps, and value-free (secret-free) failure artifacts. Every
project includes a worked example at `tests/convergence_e2e_test.ts`.

## Why lofi

- **Local-first without the plumbing.** Product code touches schema, config, islands, styles, and
  tests — never providers, workers, transports, or service-worker internals.
- **Honest by construction.** Durable storage never silently degrades to memory; diagnostics only
  claim what the underlying APIs can actually observe; identity wording matches real custody and
  recovery semantics.
- **Mobile PWA first.** Platform floors (Android Chrome 148+, iOS Safari 16.4+) are enforced boot
  gates, not advisory footnotes. Unsupported browsers get an explicit answer, never silent data
  loss.

## Stack

| Layer      | Choice                                        | Pinned at           |
| ---------- | --------------------------------------------- | ------------------- |
| Data/sync  | jazz-tools 2.0 alpha, OPFS                    | `2.0.0-alpha.53`    |
| UI runtime | Preact islands, `client:only`, thin adapter   | Preact 10 / Astro 7 |
| Shell      | Astro, fully prerendered, static-through-Deno | Astro 7             |
| Toolchain  | Deno tasks + npm-compat                       | Deno 2.9            |

Version pins are deliberate: the data layer is an alpha, so every bump is a reviewed decision.

## Status

Early release, pre-1.0. Identity is **local-first**: a new app opens on a private, on-device account
with no sign-in and no network. When a managed Jazz app is configured (`deno task jazz:provision`),
the user can elect to back up and sync that account and recover it from a 24-word **recovery
phrase** — the same account, made portable. Electing to sync preserves everything created while
local-only, because the account identity never changes. lofi holds no recoverable account material
server-side: the phrase is the backup, so keeping it is the user's custody. (The passkey/PRF module
in `src/_lofi/auth.ts` remains as an optional at-rest-encryption primitive; deriving the account
_from_ a credential was removed because it cannot preserve a pre-existing local-only account's
data.)

---

This repository is also the framework's development monorepo: `package/` is the `@nzip/lofi` source
and `apps/reference/` is the reference app the generator is validated against. See
[CONTRIBUTING.md](CONTRIBUTING.md) and the [DevX contract](docs/devx-contract.md).
