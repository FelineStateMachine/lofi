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

Passkey backup and recovery are intentionally absent. The pinned Jazz alpha exposes a rejected
credential design, so this reference uses a device-local identity and does not imply recoverability.
