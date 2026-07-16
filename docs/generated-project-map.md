# Generated project map

This is the complete file map produced by `deno run -A jsr:@nzip/lofi/create <name>`. A drift guard
compares every path below with the verified snapshot captured from the generator's actual output.

## Author boundary

Edit **author-owned** files for product work. Treat **generated `_lofi`** files, **shell assets**,
and **generated config** as framework-owned output: regenerate or patch lofi itself instead of
copying their implementation into product code. The sanctioned escape hatch is an explicit package
seam or an application-level adapter recorded in the
[DevX contract author boundary](devx-contract.md#author-boundary), not an import from `src/_lofi`.

M4 may replace selected generated `_lofi` files with imports from the single `@nzip/lofi` package.
“M4 candidate” below records that direction; it is not a currently published subpath promise.

## Files

### Root and configuration

- `.env.example` — **generated config** — names the optional public Jazz pair and server-only values
  without containing secrets; remains generated.
- `.gitignore` — **generated config** — excludes environment, build, browser, and artifact state;
  remains generated.
- `README.md` — **generated config** — prints the project journey, public tasks, Deno Tunnel path,
  and ownership link; remains generated.
- `astro.config.ts` — **generated config** — binds static Astro, Preact, Jazz, the Deno Tunnel host
  boundary, and build constants; remains generated until a proven package config seam exists.
- `deno.json` — **generated config** — pins dependencies and routes the seven public tasks through
  one `@nzip/lofi` version; remains generated.
- `tsconfig.json` — **generated config** — supplies strict Astro/Preact TypeScript settings; remains
  generated.

### Shell and PWA assets

- `public/apple-touch-icon.png` — **shell asset** — supplies the iOS home-screen icon; remains
  generated and may be branded by an explicit app asset override later.
- `public/favicon.svg` — **shell asset** — supplies the browser icon source; remains generated.
- `public/icon-192.png` — **shell asset** — supplies the Android 192px install icon; remains
  generated.
- `public/icon-512.png` — **shell asset** — supplies the Android 512px install icon; remains
  generated.
- `public/icon-maskable-192.png` — **shell asset** — supplies the Android 192px maskable icon;
  remains generated.
- `public/icon-maskable-512.png` — **shell asset** — supplies the Android 512px maskable icon;
  remains generated.
- `public/icon-maskable.svg` — **shell asset** — retains the editable source for maskable raster
  assets; remains generated.
- `public/manifest.webmanifest` — **shell asset** — declares standalone display, portable
  app-relative scope, colors, and install icons; M4 candidate for `@nzip/lofi/pwa` configuration.
- `public/sw.js` — **shell asset** — precaches the production shell, cleans old caches, serves
  offline navigation, and reports cache failures; M4 candidate for `@nzip/lofi/pwa` generation.

### Author-owned application

- `src/app.ts` — **author-owned** — selects the schema, sync/storage configuration, and trusted
  credential-origin patterns.
- `src/islands/ChecklistIsland.tsx` — **author-owned** — implements product interaction through
  sanctioned lofi hooks.
- `src/pages/index.astro` — **author-owned** — composes the product page and generated device gate.
- `src/permissions.ts` — **author-owned** — declares application access policy.
- `src/schema.ts` — **author-owned** — declares the application data model.
- `src/styles/global.css` — **author-owned** — defines product and reference-shell styling.

### Generated runtime and guards

- `src/_lofi/DeviceStatus.tsx` — **generated `_lofi`** — renders durability, install, origin,
  WebAuthn, PRF, and PWA diagnostics; M4 candidate for `@nzip/lofi/pwa` or `@nzip/lofi/ui`.
- `src/_lofi/ReferenceShell.astro` — **generated `_lofi`** — owns the HTML shell, manifest, icons,
  and boot entry; remains a generated shell until another app proves a reusable seam.
- `src/_lofi/boot.ts` — **generated `_lofi`** — starts lifecycle recovery, production PWA
  registration, and development probing; M4 candidate for package-owned boot wiring.
- `src/_lofi/checklist-store.ts` — **generated `_lofi`** — adapts the reference schema to
  local-first reads, writes, durability, and diagnostics; application-specific and replaced rather
  than published.
- `src/_lofi/checklist-store_test.ts` — **generated `_lofi`** — verifies subscription cardinality,
  durability, pending work, and mutation failures; follows the store.
- `src/_lofi/config.ts` — **generated `_lofi`** — projects the validated public Jazz pair into the
  runtime database configuration; M4 candidate for `@nzip/lofi/core` or `@nzip/lofi/sync`.
- `src/_lofi/device-capabilities.ts` — **generated `_lofi`** — gates durable storage and applies the
  author's credential-origin policy to secure origins and client capabilities; M4 candidate for
  `@nzip/lofi/core`.
- `src/_lofi/device-capabilities_test.ts` — **generated `_lofi`** — verifies durability remediation
  and stable RP-ID classification; follows the capability module.
- `src/_lofi/foreground-recovery.ts` — **generated `_lofi`** — single-flights managed reconnect
  requests from observable foreground signals; M4 candidate for `@nzip/lofi/sync`.
- `src/_lofi/foreground-recovery_test.ts` — **generated `_lofi`** — verifies BFCache, visibility,
  online, offline-deferral, and local-only lifecycle behavior; follows the recovery module.
- `src/_lofi/inspector.ts` — **generated `_lofi`** — defines and renders the value-free development
  inspector; may remain development tooling inside the package.
- `src/_lofi/inspector_test.ts` — **generated `_lofi`** — prevents inspector rows from fabricating
  vendor state or exposing secret-shaped fields; follows the inspector.
- `src/_lofi/lifecycle.ts` — **generated `_lofi`** — binds browser lifecycle events to the reference
  runtime's public reconnect method; M4 candidate for `@nzip/lofi/sync`.
- `src/_lofi/probe.ts` — **generated `_lofi`** — connects the development inspector to runtime,
  storage, lifecycle, and safe control actions; may remain package development tooling.
- `src/_lofi/pwa.ts` — **generated `_lofi`** — owns service-worker registration, install prompting,
  updates, and visible failure state; M4 candidate for `@nzip/lofi/pwa`.
- `src/_lofi/pwa_test.ts` — **generated `_lofi`** — verifies activation and platform install
  classification; follows the PWA module.
- `src/_lofi/resource-lifecycle.ts` — **generated `_lofi`** — serializes runtime creation,
  recreation, shutdown, and HMR disposal; M4 candidate for `@nzip/lofi/core`.
- `src/_lofi/resource-lifecycle_test.ts` — **generated `_lofi`** — verifies single-flight recreation
  and obsolete HMR attachment rejection; follows the lifecycle primitive.
- `src/_lofi/runtime.ts` — **generated `_lofi`** — owns the singleton Jazz database, identity secret
  store, adapter, and runtime diagnostics; M4 candidate for `@nzip/lofi/core`.
- `src/_lofi/test-assert.ts` — **generated `_lofi`** — supplies dependency-free assertions for
  generated runtime tests; remains generated or moves to package testing.
- `src/_lofi/ui-mutation.ts` — **generated `_lofi`** — contains the UI promise settlement boundary;
  M4 candidate for `@nzip/lofi/ui`.
- `src/_lofi/ui-mutation_test.ts` — **generated `_lofi`** — verifies UI rejection handling after
  runtime projection; follows the mutation boundary.
- `src/_lofi/use-checklist.ts` — **generated `_lofi`** — exposes the reference store to Preact with
  stable external-store semantics; application-specific and replaced by proven package hooks.
- `src/_lofi/use-device-capabilities.ts` — **generated `_lofi`** — exposes asynchronous browser
  capability and persistence state to Preact; M4 candidate for `@nzip/lofi/pwa` or `@nzip/lofi/ui`.
- `src/env.d.ts` — **generated config** — declares Astro/Vite and lofi build-time environment types;
  remains generated config-adjacent plumbing.
- `src/migrations/20260715T194947-notes-to-tasks-6c62fec42c35-ff85ac1d97ee.ts` — **author-owned** —
  seeds the reviewed reference schema migration edge; future schema tooling may generate changes,
  but the application author owns and reviews its migration history.
- `src/migrations/snapshots/20260715T194819-6c62fec42c35.json` — **author-owned** — seeds the
  predecessor schema fingerprint; the application owns this generated migration evidence.
- `src/migrations/snapshots/20260715T194947-ff85ac1d97ee.json` — **author-owned** — seeds the
  current schema fingerprint; the application owns this generated migration evidence.
- `src/ui-contract.ts` — **author-owned** — centralizes accessible names used by product UI and
  golden tests; the generated reference gives the author the initial contract.
- `tests/author-boundary_test.ts` — **generated `_lofi`** — prevents product files from importing or
  reproducing framework plumbing; remains a generated guard.
- `tests/testing-contract_test.ts` — **generated `_lofi`** — type-checks the public
  `@nzip/lofi/testing` surface in generated projects; remains a generated package contract.

## M3 touch points

- Install and offline hardening: manifest, icons, `sw.js`, `pwa.ts`, `DeviceStatus.tsx`.
- Stable HTTPS and future RP ID: `astro.config.ts`, `device-capabilities.ts`, generated `README.md`,
  and `deno.json` command usage.
- Foreground recovery: `foreground-recovery.ts`, `lifecycle.ts`, `runtime.ts`, `probe.ts`, and their
  tests.
- Physical-device evidence stays outside generated source in the repository's
  [M3 checklist](m3-device-checklist.md).
