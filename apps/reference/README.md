# lofi reference application

This application proves the author-facing lofi workflow before framework packages are extracted. It
is deliberately split into two ownership zones.

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

Application work should not require edits in `src/_lofi/`. Its local path is a temporary extraction
seam: later M2 work may replace it with generated files or packages without changing product UI.

Passkey backup and recovery are intentionally absent. The pinned Jazz alpha exposes a rejected
credential design, so this reference uses a device-local identity and does not imply recoverability.
