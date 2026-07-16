# lofi reference application

This application proves the author-facing lofi workflow while the public `@nzip/lofi` package is
graduated in layers. M2 extracts the generated-project commands; broader framework API extraction
remains M4 work. The application is deliberately split into two ownership zones.

## Author-owned files

- `src/schema.ts` — application data model
- `src/permissions.ts` — application access policy
- `src/app.ts` — named application configuration
- `src/pages/` — product pages and shell content
- `src/islands/` — product interaction and rendering
- `src/styles/` — product styling
- `tests/` — product behavior and author-boundary tests

## Generated and runtime-owned files

- `astro.config.ts`, `tsconfig.json`, and `src/env.d.ts` — compatible toolchain wiring
- `public/manifest.webmanifest`, `public/sw.js`, and `public/favicon.svg` — PWA plumbing
- `src/_lofi/` — storage, identity, synchronization, lifecycle, diagnostics, and framework adapter

Application work should not require edits in `src/_lofi/`. The M2 generator copies these validated
runtime-owned files without turning them into public framework APIs. M4 may replace the local seam
with proven `@nzip/lofi` subpath imports without changing product UI.

Browser journeys import readiness, offline, two-client, and sanitized failure-artifact helpers from
`@nzip/lofi/testing`. `tests/convergence_e2e_test.ts` is a worked example: two clients add a task
offline and converge after reconnecting. The normal `deno task test` skips it (and never launches
Chromium); run it against a synced deployment with
`LOFI_E2E_BASE_URL=http://127.0.0.1:4321/ deno test -A tests/convergence_e2e_test.ts`.

## Deploy

`deno task build` produces a self-contained static PWA in `dist/` (the Preact islands compile to
`dist/_astro/*.js`). The deploy tasks build locally, then push `dist/` **as the deploy root** to
Deno Deploy's static hosting:

- `deno task deploy:create --org <org> --app <app>` — one-time: create the app from the built
  `dist/` as a static site (`--runtime-mode static --static-dir .`).
- `deno task deploy` — ongoing: build, then `deno deploy --prod dist`.

Pushing `dist/` as the root is deliberate. If you deploy the project directory instead, Deno
Deploy's framework detection sees `src/app.ts` and the `@nzip/lofi` imports and runs a **remote
build** of the whole app — which fails here, because those imports are monorepo-relative
(`../../package`) and don't exist on the build machine (`Module not found file:///tmp/package/...`).
Deploying the prebuilt `dist/` has nothing to build and nothing to misdetect, so it serves as pure
static assets.

Supply the org/app once with `deno deploy switch` (or the `--org/--app` flags above); the `deploy`
field in `deno.json` records this app's target for reference. The generator strips that field so a
new project records its own association on first deploy.

Passkey backup and recovery are intentionally absent. The pinned Jazz alpha exposes a rejected
credential design, so this reference uses a device-local identity and does not imply recoverability.
