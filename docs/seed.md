# lofi — Local-First Mobile PWA Meta-Framework (Prototype Plan)

> **Historical prototype plan—do not use as API or template documentation.** Several identities,
> paths, package exports, and implementation choices below were rejected or replaced. Application
> developers should use the [current developer documentation](README.md); framework contributors can
> consult the [developer-experience contract](devx-contract.md) and retained spike evidence.

Working name **`lofi`** (import paths like `@nzip/lofi/core`). Goal: validate that Jazz + Preact
islands + Astro + Deno can be wrapped into an ergonomic framework where the UI always hydrates from
local data, identity is passkey-only, and **the only network surface an app developer ever sees is
the sync module's primitives/hooks**.

Scope decisions: prototype-to-learn (not a published framework yet); Deno is the dev toolchain and
shell host; sync backend is Jazz Cloud (no self-hosted server); **Jazz 2.0 alpha with OPFS,
targeting Android Chrome 148+ / iOS Safari 16.4+ as hard floors**.

## Stack

| Layer              | Choice                                                                | Why                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell              | **Astro 7 + @deno/astro-adapter**, all routes `prerender = true`      | Prerendered app shell (instant paint, SW-precacheable); SSR of local CoValues is meaningless, so the adapter is just a first-class Deno server for the shell + a future escape hatch. Fresh 2.3 has no PWA tooling; a Preact SPA has no prerendered shell. |
| UI runtime         | **Preact 10 islands via `client:only="preact"`**                      | Skips SSR entirely — correct when all data hydrates from local storage.                                                                                                                                                                                    |
| Data               | **jazz-tools 2.0 alpha (pinned exact version), OPFS persistent mode** | ~5x faster than the 0.20.x IndexedDB backend. Persistence requires SharedWorker + Web Locks + MessageChannel; fallback is memory-only — hence the hard platform floors below.                                                                              |
| Sync backend       | **Jazz Cloud** (managed WebSocket)                                    | Zero-config; self-hosting later changes nothing client-side.                                                                                                                                                                                               |
| Auth               | **Jazz PasskeyAuth + 24-word passphrase recovery**                    | Jazz custodies the account secret in a resident WebAuthn credential; wrap, don't reinvent. PRF-derived E2E-at-rest is an optional stretch.                                                                                                                 |
| PWA                | **@vite-pwa/astro v1.2 (Workbox)**                                    | SW's job stays deliberately small: shell precache + push readiness. The SW never touches sync or OPFS. Full prerender = full offline shell for free (precache only covers prerendered routes).                                                             |
| Cross-island state | **@preact/signals + module-scope singleton client**                   | React/Preact context can't cross Astro island boundaries; a module singleton + signals sidestep it. No provider component in the public API.                                                                                                               |
| Toolchain          | **Deno 2.9** task runner + server; Astro/Vite under npm-compat        | Fallback if npm-compat friction appears: Node for `astro build` only, Deno for everything else.                                                                                                                                                            |

## Platform floors (enforced, not advisory)

Jazz 2.0's only fallback below these floors is memory-only storage, which silently loses data — so
`@nzip/lofi/core`'s `detect()` is a **boot gate**: unsupported browser → explicit "unsupported"
screen (or opt-in memory mode with a "nothing will persist" banner). Never a silent fallback.

| Feature                                         | iOS Safari tab                                  | iOS installed PWA | Android Chrome 148+                                     | Framework behavior                                                                         |
| ----------------------------------------------- | ----------------------------------------------- | ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| SharedWorker + Web Locks (Jazz 2.0 persistence) | ✅ 16.4+ (WebKit quirks — Spike 0.5)            | ✅                | ✅ (148 restored SharedWorker, adds `extendedLifetime`) | Boot gate                                                                                  |
| Storage eviction safety                         | ❌ 7-day ITP                                    | ✅ exempt         | ✅ generous                                             | Push install aggressively on iOS tabs ("installing protects your data")                    |
| `storage.persist()`                             | needs notification permission                   | same              | heuristic grant                                         | `requestPersistentStorage()` sequences the permission dance                                |
| Install                                         | Share-sheet only; **EU iOS: unavailable (DMA)** | —                 | `beforeinstallprompt` / WebAPK                          | iOS coach-mark; Android native prompt; EU degrade banner                                   |
| Background Sync (all variants)                  | ❌ never                                        | ❌ never          | ✅                                                      | **Unused everywhere** — sync is foreground-only (lowest common denominator, simpler model) |
| WebSocket while backgrounded                    | drops                                           | drops             | drops/throttled                                         | Reconnect on `visibilitychange`/`pageshow`/`online`                                        |
| Push                                            | ❌                                              | ✅ 16.4+          | ✅                                                      | Out of prototype scope; SW is push-ready                                                   |
| WebAuthn passkeys                               | ✅ iCloud Keychain                              | ✅                | ✅                                                      | Primary auth                                                                               |
| WebAuthn PRF                                    | Safari 18+, no external keys                    | same              | robust                                                  | Stretch phase only; feature-detect, never require                                          |

App code never sniffs user agents — `@nzip/lofi/pwa` and `@nzip/lofi/sync` branch on the
`Capabilities` object from `detect()`.

## Monorepo layout (Deno workspace)

```
lofi/
├── deno.json                      # workspace: ./packages/lofi, ./apps/demo; shared tasks
├── packages/
│   └── lofi/      # @nzip/lofi — one JSR package, one version, subpath exports
│       ├── core/  # ./core — schema (re-export co/z + defineSchema), createApp(), detect()
│       ├── auth/  # ./auth — passkey registration/sign-in/recovery and authState
│       ├── sync/  # ./sync — THE ONLY NETWORK-AWARE MODULE and lifecycle manager
│       ├── ui/    # ./ui — context-free Preact hooks and adapter implementation
│       ├── pwa/   # ./pwa — PWA config, install orchestration, persistent-storage UX
│       ├── testing/ # ./testing — virtual-authenticator and offline/sync test helpers
│       └── create/  # ./create — non-interactive project creation command
└── apps/demo/     # Astro app: "Ticktick-lite" checklist; schema.ts, app.ts, islands/
```

The public modules are subpath exports of `@nzip/lofi`, not separately versioned packages.
Dependency direction remains strict inside that package: `demo → ui,pwa,auth,sync,core` ·
`ui → sync,auth,core` · `pwa → core` · `sync → core` · `auth → core` · `core → npm:jazz-tools` and
nothing else. **Only `sync` may construct or configure a network peer** — the enforcement point for
the "sync is the only network surface" constraint.

Multi-tab coordination comes free: the SharedWorker Jazz 2.0 already requires is the single owner of
storage (and possibly sync) across tabs. Open question for Spike 0: does Jazz 2.0 run the sync
WebSocket inside the worker or per-tab? That decides where `lifecycle.ts` attaches its reconnect
manager.

## Public API sketch

```ts
// schema.ts
import { co, defineSchema, z } from "@nzip/lofi/core";
export const Task = co.map({ text: z.string(), done: z.boolean(), createdAt: z.date() });
export const TaskList = co.list(Task);
export const schema = defineSchema({
  root: co.map({ lists: co.list(TaskList) }),
  profile: co.map({ name: z.string() }),
  migration: (account) => {
    if (!account.root) account.root = { lists: [] };
  },
});

// app.ts — module scope, imported by every island (Vite guarantees one instance per page)
import { createApp } from "@nzip/lofi/core";
export const app = createApp({
  schema,
  sync: { peer: `wss://cloud.jazz.tools/?key=${import.meta.env.PUBLIC_JAZZ_KEY}` },
  storage: "opfs",
});
// createApp() registers config only; the client boots lazily on first hook/auth call,
// and the sync peer is attached exclusively by @nzip/lofi/sync.
```

```tsx
// islands/TaskListView.tsx
import { useCoState } from "@nzip/lofi/ui";
export default function TaskListView({ listId }) {
  const list = useCoState(TaskList, listId, { resolve: { $each: true } });
  if (list === undefined) return <Spinner />; // still loading from OPFS
  if (list === null) return <NotFound />; // unavailable / no permission
  return (
    <ul>
      {list.map((t) => (
        <li key={t.id}>
          <input
            type="checkbox"
            checked={t.done}
            onChange={() => {
              t.done = !t.done;
            }}
          />{" "}
          {t.text} {/* local write; sync invisible */}
        </li>
      ))}
    </ul>
  );
}

// The only place networking is even visible:
const { connected, syncing, pendingOps, lastSyncedAt } = useSyncStatus();
```

Auth: `await registerPasskey({ name })` · `await signInWithPasskey()` (conditional-UI capable) ·
`await recoverWithPassphrase(words24)`. Hooks read module-scope signals — no provider component
exists, which is what makes multi-island apps work.

## The Preact adapter decision (riskiest unknown — resolve first)

- **Plan A (spike):** alias `react`/`react-dom`/`react/jsx-runtime` → `preact/compat` in a bare Vite
  page; mount jazz-tools/react's provider + `useCoState` + PasskeyAuth. Watch:
  `useSyncExternalStore` under compat, React-19-only APIs, synthetic-event assumptions.
- **Plan B (fallback; likely end-state):** hand-rolled hooks over jazz-tools' vanilla
  `subscribe`/`load` API. `useCoState` ≈ 30 lines (`useState` + `useEffect` around
  `Schema.subscribe(id, opts, set)`); `useAccount` ≈ 20; sync/auth hooks are just signal readers.
  **~200–300 LOC total**, no compat alias in app bundles.
- Decision rule: any flakiness in Plan A → take Plan B immediately. Adopt Plan A only if it's
  boringly perfect.
- Either way the public hooks are **context-free** (module-scope client + signals), because context
  can't span Astro islands. The spike only decides whether we reuse jazz-tools/react's hook
  internals.

## Risk-ordered roadmap

| #   | Phase                                                                                                                                                                                                                                                                                              | Duration | Learn / kill criteria                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Spike: preact/compat × jazz-tools 2.0** — bare Vite+Preact page (no Astro, no Deno), Plan A then Plan B, anonymous account, `useCoState` round-trip to Jazz Cloud; measure gzipped bundle; find where the sync socket lives (worker vs tab)                                                      | 2 days   | Which adapter plan; bundle cost. **Kill:** both plans fail to subscribe reliably → Jazz choice is dead, re-evaluate data layer                                                                 |
| 0.5 | **Spike: OPFS persistence on real devices** — same page with `storage: "opfs"` on a real iPhone (Safari tab + installed) and a real Chrome-148 Android; kill/relaunch, check data survives; multi-tab open                                                                                         | 2 days   | Does Jazz 2.0 persistent mode actually work on WebKit's SharedWorker. **Kill:** broken on iOS → fall back to jazz-tools 0.20.x/IndexedDB (architecture unchanged — `storage:` is a named seam) |
| 1   | **Spike: PasskeyAuth on real devices** — register/sign-in/passphrase-recovery over real HTTPS on iOS Safari tab, installed PWA, Android Chrome, WebAPK; verify the credential survives install                                                                                                     | 3 days   | Does Jazz's passkey custody work on mobile Safari (its PRF/largeBlob mechanism is undocumented — this is where we find out). **Kill:** fails on iOS → passphrase-primary UX or reconsider      |
| 2   | **Astro shell + islands + Deno toolchain** — scaffold workspace, port spikes into `@nzip/lofi` subpath modules, two _separate_ islands sharing one client and live-updating each other (acceptance test for the singleton design); `deno task dev/build/serve` end-to-end with @deno/astro-adapter | 1 wk     | Island-boundary state sharing works; npm-compat friction. **Soft kill:** Astro misbehaves under Deno → Node for build, Deno for serve; cap at 1 day                                            |
| 3   | **PWA hardening** — Workbox shell precache, manifest, Android install prompt, iOS coach-mark, EU-iOS degrade, `storage.persist()` incl. Safari notification-permission dance, reconnect-on-foreground verified on devices                                                                          | 1 wk     | Offline cold-start (airplane mode → installed PWA → shell + data render); WS reconnect reliability. Failures here are degradable UX, not fatal                                                 |
| 4   | **Demo app "Ticktick-lite"** — checklists, shared lists via Group invite links (two accounts, two devices), sync badge, offline edits, conflict-free merge test                                                                                                                                    | 1 wk     | Is the API pleasant; where the abstraction leaks; invite-revocation gap surfaces concretely                                                                                                    |
| 5   | **(Stretch) PRF-derived E2E-at-rest** — WebAuthn PRF → HKDF → field-level encryption before data enters Jazz                                                                                                                                                                                       | optional | Only if a real threat model demands it; Safari 18 iCloud-Keychain-only; feature-detect, never require                                                                                          |

## Verification

- **Secure-context device testing:** WebAuthn + SW need HTTPS and a _stable origin_ (rpId changes
  break passkeys). Preferred: `tailscale serve` (stable `*.ts.net` name); alt: reserved ngrok
  domain; mkcert for pure LAN (requires installing the root CA profile on iOS). `astro dev` behind
  the tunnel for iteration; the Deno adapter serves the built shell.
- **Per-phase device pass:** one-page manual checklist on a physical iPhone (tab + installed) and
  Android (tab + WebAPK); debug via Safari Web Inspector over USB and `chrome://inspect`.
- **CI-able WebAuthn:** Playwright CDP virtual authenticator (resident key + user verification) in
  `@nzip/lofi/testing` for register/sign-in/recovery. Real-device passkey behavior still verified
  manually in Spike 1 (virtual authenticators don't model iCloud Keychain or PRF quirks).
- **Offline:** Playwright `context.setOffline(true)` for automated shell+data cold-start; manual
  airplane mode on devices for the installed path.
- **Sync/merge:** two Playwright contexts against a throwaway Jazz Cloud key: concurrent offline
  edits → reconnect → assert convergence.
- **Lifecycle:** manual — background the installed PWA 5+ min on iOS, foreground, assert reconnect +
  flush via the sync badge.

## Open risks (ranked)

1. **preact/compat × jazz-tools untested** — highest uncertainty, cheapest to resolve (Spike 0);
   Plan B fallback is fully designed and small.
2. **Jazz 2.0 OPFS persistence on WebKit** — SharedWorker on iOS Safari exists but is quirk-prone;
   Spike 0.5 decides. Fallback to 0.20.x/IndexedDB costs nothing architecturally (`storage:` seam).
3. **Alpha API churn** — pin the exact 2.0-alpha version; expect breakage on every bump;
   `@nzip/lofi/core` is the single jazz-tools chokepoint containing migration cost. 2.0 docs are
   sparse — read the changelog and source when docs fail.
4. **Pre-148 Android installed base** — SharedWorker only returned in Chrome 148 (stable ~May–June
   2026); older devices hit the boot gate. Acceptable for a prototype; revisit for any real release.
5. **Astro-under-Deno friction** — pre-agreed fallback: Node for `astro build`, Deno for everything
   else.
6. **Jazz bundle size unknown** — measure in Spike 0; `client:only` islands keep it off the shell's
   critical path.
7. **iOS lifecycle fragility** — WS drops + eviction + `persist()` permission gating compound; Phase
   3 is dedicated to it; the sync badge makes failures visible instead of silent.
8. **Jazz invites can't be revoked/expired** — leaked link = standing access. Prototype: scope
   invites to writer role; "revoke" = recreate the list into a fresh Group. Framework-level gap for
   any real release.
9. **EU iOS install ban (DMA)** — browser-only mode means eviction exposure with no fix; accepted
   for the prototype, flagged for distribution.

## Research appendix (mid-2026 findings)

- **Jazz**: v0.20.18 stable / 2.0 alpha. Schema `co.map/co.list/co.feed` + Zod; `FileStream` binary;
  Groups (reader/writer/admin). Bindings: React, Svelte, Solid (2.0α), vanilla — **no Preact
  binding**. PasskeyAuth custodies the account secret in a resident credential (PRF/largeBlob use
  unconfirmed). Sync = WebSocket to Jazz Cloud or self-hosted Node 20+ (Deno Deploy unsupported —
  moot here). 2.0-alpha OPFS ≈ 5x faster reads/writes; persistent mode requires SharedWorker + Web
  Locks + MessageChannel, fallback memory-only.
- **Frontends**: Astro 7.0.7 (static default, `client:only`, @vite-pwa/astro v1.2,
  `@deno/astro-adapter`); Fresh 2.3.3 (Deno-native, islands, **zero PWA/SW tooling** → rejected);
  Preact 10 + Vite (SPA only, no prerendered shell → rejected). preact/compat caveats: no React-19
  `use()`, native events, concurrent rendering no-op.
- **Platform**: Chrome 148 restored SharedWorker on Android (+ `extendedLifetime`). iOS: installed
  PWAs exempt from 7-day ITP eviction, tabs are not; no Background Sync of any kind, ever; push only
  in installed PWAs 16.4+; `storage.persist()` requires notification permission; EU iOS can't
  install PWAs (DMA). PRF output is deterministic per credential → synced passkeys yield the same
  derived key across devices.
- **Niche**: no existing project combines passkey identity + CRDT sync + mobile-PWA-first
  constraints (Evolu = mnemonic; Automerge = `localfirst/auth` teams; DXOS = HALO keys;
  Zero/Triplit/PowerSync = JWT/cloud-first; Ditto = device identity). The niche is open.
