# lofi developer-experience contract

Status: **v0 validated through the M2 source layers; combined promotion review in progress**\
Scope: **M0 contract, M1 feasibility, and M2 DevX graduation**\
Last reviewed: **2026-07-15**

This is the product contract for lofi. Implementation choices are provisional until they satisfy
these promises. Each M1 spike must cite the contract IDs it tested, retain repeatable evidence, and
record a contract delta even when the result does not change the contract.

The older `init.md` is research input, not an authoritative description of Jazz or browser behavior.

## Status and merge rules

- **proposed** — a falsifiable promise awaiting evidence.
- **validated** — demonstrated by retained automated or device evidence.
- **revised** — changed because evidence disproved or narrowed the original promise.
- **deferred** — valuable but intentionally owned by a later milestone.
- **rejected** — disproved or incompatible with the product direction.

The promises marked **M1 gate: yes** were validated, revised, or rejected before M1 merged. A
post-M1 promise may remain proposed only when it has a named milestone and does not affect the
honesty of the graduated reference application.

## Two distinct journeys

### North-star generated-project journey

This is the product experience validated from M2 source. The registry command remains unavailable
until the first explicitly authorized publish and registry-backed smoke.

```sh
deno run -A jsr:@nzip/lofi/create my-app
cd my-app
deno task dev
```

The JSR surface is one package, `@nzip/lofi`, with one version and publish operation. M2 validates
the command subpaths plus `./testing`; remaining runtime subpaths such as `./core`, `./sync`,
`./auth`, `./ui`, and `./pwa` graduate only when M4 proves their seams through another application.
See [ADR 0005](decisions/0005-publish-one-nzip-lofi-package.md).

From there the developer makes a retained local write, reloads it, works offline, runs checks,
builds, previews, and opens the same stable secure origin on a physical device.

### M1 graduation journey

M1 validates the stack and contract from a repository checkout, without pretending that the M2
generator exists:

```sh
git clone https://github.com/FelineStateMachine/lofi.git
cd lofi
deno task dev
```

The graduated M1 application, now retained as `apps/reference`, must support a local write, reload,
offline cold-start and edit, check, test, build, and preview. It does not claim observable transport
reconnection or convergence because the pinned Jazz API exposes neither signal; that remains a later
test contract. Git is a contributor prerequisite for this repository journey; Deno remains the only
required global runtime for a generated application.

## End-to-end journey contract

| Step          | Developer action                                                                | Required result                                                                                       | Representative failure and recovery                                                                          |
| ------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Create        | Run the create command with a project name.                                     | A complete directory is produced without prompts and the next two commands are printed.               | Existing/non-empty destination names the conflict and suggests a new path; no overwrite occurs.              |
| Configure     | Start with no `.env`, or copy `.env.example` and provide the public cloud pair. | No config selects explicit local-only mode; a complete pair selects cloud mode.                       | Partial/invalid config stops boot, states that sync cannot start, and says which name to set or remove.      |
| Develop       | Run `deno task dev`.                                                            | One local URL, storage mode, identity state, sync mode, and PWA readiness are printed.                | Unsupported durable storage stops or requires explicit ephemeral opt-in; it never silently degrades.         |
| First write   | Use the starter UI to create data.                                              | UI updates without awaiting network; data survives reload or runtime recreation.                      | A failed durable write is visible in UI and diagnostics with impact and remediation.                         |
| Reload/HMR    | Reload and edit an island five times.                                           | Identity and local data remain; client/subscription counts do not grow.                               | Duplicate runtime resources fail a development assertion with the responsible subsystem named.               |
| Offline       | Disable network, cold-start, read, and edit.                                    | Local behavior continues; returning online makes no unsupported connection-state claim.               | Unsupported or failed sync remains visible; convergence waits for an explicit observable test seam.          |
| Check/test    | Run `deno task check` and `deno task test`.                                     | Static checks and deterministic local-first tests pass without hidden global tools in generated apps. | Failure prints the failing check and preserves browser/log evidence.                                         |
| Build/preview | Run `deno task build`, then `deno task preview`.                                | Production output is served through the supported Deno path.                                          | npm-compat or adapter failure names the internal fallback; no undocumented user-facing Node command appears. |
| Device        | Open the printed stable HTTPS origin on a phone.                                | Secure-context, storage, install, and passkey capability are diagnosed.                               | An unstable relying-party ID is rejected before passkey creation and the stable-origin action is named.      |

## Measurement protocol

- Record Deno, package, OS, browser, device, commit SHA, and whether caches were warm.
- Time uncached creation separately from cached startup; dependency download is never hidden from
  the uncached result.
- For startup and HMR, retain five samples and report median plus slowest sample. Startup begins
  when the command is invoked and ends when the usable URL is printed. HMR begins when a watched
  file is saved and ends when the updated UI is observable.
- A **retained local write** must survive a full page reload or explicit client recreation.
- A **subscription leak** means the count after five edit/reload cycles exceeds the initial steady
  count for the same mounted consumers.
- Common configuration failures must be recoverable with one described edit and one rerun; record
  whether recovery took more than 60 seconds.
- Device results retain the manual checklist plus logs or screenshots; “worked once” is not
  evidence.

## Measurable promises

| ID              | Promise                                                        | v0 budget or condition                                                                                                                                          | Evidence owner                   | M1 gate | Status    |
| --------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------- | --------- |
| DX-CREATE-01    | Named creation is non-interactive.                             | Deno is the only required global runtime; zero prompts; uncached time reported.                                                                                 | M2 source; cold registry pending | no      | proposed  |
| DX-CMD-01       | The public command surface is small.                           | create, dev, doctor, check, test, build, preview only.                                                                                                          | #2 and #6                        | yes     | validated |
| DX-TTFW-01      | Generated create-to-retained-write is fast.                    | At most three shell commands and two minutes on the recorded machine/network.                                                                                   | M2 source; cold registry pending | no      | proposed  |
| DX-PROTOTYPE-01 | The M1 checkout reaches a retained write quickly.              | `deno task dev` to retained write within 60 seconds after cached setup.                                                                                         | integrated M1 prototype          | yes     | validated |
| DX-START-01     | Cached development startup feels immediate.                    | Warm median at most 2 seconds; slowest at most 5 seconds across five samples.                                                                                   | #6                               | yes     | validated |
| DX-HMR-01       | UI edits retain state and runtime cardinality.                 | Median feedback at most 300 ms; one client and one vendor subscription per shared query after five edits.                                                       | #5 and #6                        | yes     | validated |
| DX-AUTHOR-01    | Product edits avoid framework plumbing.                        | The integrated task changes only schema, app config, page/island, style, or test files.                                                                         | integrated prototype             | yes     | validated |
| DX-LEAK-01      | Runtime machinery stays outside product UI.                    | No provider, raw client, worker, transport URL, Workbox config, or browser branch in product UI.                                                                | #5, #6, integration              | yes     | validated |
| DX-LOCAL-01     | Local work does not await network/auth round trips.            | Subscribed UI reflects an offline write in the same event turn or next render; reload retains it.                                                               | #7                               | yes     | validated |
| DX-DUR-01       | Durable mode never silently becomes ephemeral.                 | Boot reports durable, unsupported, or explicitly opted-in memory mode.                                                                                          | #4 and #7                        | yes     | validated |
| DX-SYNC-01      | Application-data transport has one lofi-owned surface.         | App config selects a named adapter; product UI never constructs peers or transports.                                                                            | #7 and integration               | yes     | validated |
| DX-OBS-01       | Diagnostics expose only truthful signals.                      | Configured state and per-write durability map to public APIs; unavailable transport detail is named.                                                            | #7                               | yes     | validated |
| DX-ENV-01       | Environment handling is safe by construction.                  | Real env ignored; allowlisted loader; server values absent from client projection and built output.                                                             | #3, #7, final build              | yes     | validated |
| DX-ERROR-01     | Failures state capability, impact, and action.                 | No secret values; common config recovery is one edit plus rerun.                                                                                                | #3, #4, #6                       | yes     | validated |
| DX-AUTH-01      | Identity wording matches custody/recovery.                     | UI identifies the device-local key, blocks the rejected alpha passkey path, and defines any future phrase as an identity bearer secret rather than data backup. | #8                               | yes     | revised   |
| DX-DEVICE-01    | Device/auth tests use a stable, appropriately isolated origin. | M1 proves a stable HTTPS PWA scope for OPFS; installed-app RP-ID preservation and identity isolation remain required before any replacement passkey ceremony.   | #4 and #8                        | yes     | revised   |
| DX-DEVICE-UX-01 | Device preview is one productized command.                     | Primary path prints stable URL, capability report, and remediation.                                                                                             | M3                               | no      | proposed  |
| DX-OFFLINE-01   | Installed production cold-start renders retained data offline. | Airplane-mode launch renders shell and data.                                                                                                                    | feasibility #4; full M3          | no      | proposed  |
| DX-BUILD-01     | Development and production share the Deno command contract.    | `deno task build` and `preview`; no undocumented Node command.                                                                                                  | #6                               | yes     | validated |
| DX-TEST-01      | Local-first tests avoid hand-timed sleeps.                     | Readiness-based offline/two-client primitives.                                                                                                                  | #7 and M2 Layer 3                | no      | validated |

## Canonical command surface and output contract

These outputs are implemented and verified from M2 source. The `create` registry invocation remains
conditional on an explicitly authorized publish and registry-backed smoke; the generated command
surface itself is covered by the source-backed golden journey.

| Command                                    | Success output must contain                                | Failure output must contain                                                |
| ------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `deno run -A jsr:@nzip/lofi/create <name>` | Created path and exact `cd`/`deno task dev` next steps.    | Conflicting input/path, unchanged-files guarantee, and corrective command. |
| `deno task dev`                            | Usable URL plus storage, identity, sync, and PWA states.   | Failed subsystem, developer impact, and one remediation.                   |
| `deno task doctor`                         | Versioned capability/configuration table without values.   | Invalid/unsupported item plus remediation; nonzero exit for blockers.      |
| `deno task check`                          | Checks run and concise pass summary.                       | First failing check and rerun command.                                     |
| `deno task test`                           | Suites, durations, and retained failure-artifact location. | Failing scenario and artifact location without fixed-sleep advice.         |
| `deno task build`                          | Output path, route count, and secret-scan result.          | Failed internal tool/adapter and supported fallback action.                |
| `deno task preview`                        | Production URL and build identity.                         | Missing/stale build and exact build command.                               |

Example successful development output:

```text
lofi dev
Local:       http://localhost:4321
Storage:     OPFS durable
Identity:    local-first; passkey backup not configured
Sync:        configured; last write confirmed global; live connection detail unavailable
PWA:         development service worker disabled
```

Example configuration failure:

```text
lofi environment mode: invalid
error: Cloud sync cannot start because configuration is incomplete; set JAZZ_SERVER_URL or remove
the partial JAZZ_APP_ID/JAZZ_SERVER_URL pair to run local-only.
```

## Generated-project layout

```text
my-app/
├── deno.json
├── astro.config.ts
├── .env.example
├── public/
├── src/
│   ├── schema.ts
│   ├── permissions.ts
│   ├── app.ts
│   ├── pages/
│   ├── islands/
│   ├── styles/
│   └── _lofi/                 # generated; not author-edited
└── tests/
```

The exact layout may change only when verified toolchain behavior requires it or the change removes
an author-facing concept. `src/_lofi/` is generated machinery, not an author-editing surface.

## Author boundary

| Location                   | Default allowance                                             | M1 qualification                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product UI/pages/islands   | lofi components/hooks and application types only.             | Raw Jazz, worker, transport, Workbox, and capability branching are forbidden.                                                                             |
| `schema.ts`                | Application schema declarations.                              | Direct pinned Jazz 2 schema declarations are allowed in the M1 prototype until #7 determines whether a lofi-owned schema facade is honest and affordable. |
| `permissions.ts`           | Application access policy next to the schema.                 | Direct pinned Jazz 2 permission declarations are allowed; Jazz tooling watches this location.                                                             |
| `app.ts`                   | Named lofi configuration and composition.                     | Raw vendor setup is allowed only inside spike controls, not the graduated prototype.                                                                      |
| Generated/internal runtime | Vendor clients, workers, storage, sync, auth, and PWA wiring. | May change across alpha pins without changing product UI.                                                                                                 |
| Escape-hatch module        | Explicitly isolated unsupported vendor access.                | Never generated by default; no compatibility promise before framework extraction.                                                                         |

## Safe defaults

- **Schema:** use the smallest verified Jazz 2 surface during M1; do not invent a second schema
  language before #7.
- **Identity:** create or restore the verified local-first identity without a server round trip;
  passkey backup is never mislabeled as conventional login.
- **Sync:** no config means clearly reported local-only mode if supported; a complete public pair
  enables the named managed adapter.
- **Storage:** request the verified durable browser driver; unsupported capability stops boot or
  requires an explicit development-only ephemeral opt-in.
- **PWA:** prerendered shell and offline production behavior are the target, while service-worker
  ownership remains outside Jazz storage/sync.
- **Testing:** unit and browser controls use readiness signals; physical-device gaps stay explicit.
- **Security:** generated examples contain names only; server credentials never enter client
  projection, logs, QR codes, build output, or browser assets.

## Environment contract

The four names are lofi's configuration API. #7 confirmed that the complete public pair can be
mapped at the Deno/Vite edge without projecting the server-only pair. The vendor's
`VITE_JAZZ_APP_ID` and `VITE_JAZZ_SERVER_URL` names remain internal implementation details.

| Name                | Provisional classification | Contract                                                                      |
| ------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| `JAZZ_APP_ID`       | client-visible identifier  | Enters client config only as part of a validated complete public pair.        |
| `JAZZ_SERVER_URL`   | client-visible endpoint    | Enters the named adapter; raw product-UI use is forbidden.                    |
| `JAZZ_ADMIN_SECRET` | server-only secret         | Never projected, logged, generated with a value, or built into client assets. |
| `BACKEND_SECRET`    | server-only secret         | Never projected, logged, generated with a value, or built into client assets. |

The allowlisted loader reads an optional ignored `.env`; an explicitly set process value wins.
Missing public configuration selects local-only mode if #7 verifies support. Partial or invalid
cloud configuration is `invalid`, stops the relevant command, and cannot be projected into client
config. Server-only values without client configuration remain isolated and produce a warning.

Root-repository ignore and leak tests are supplemented by generated-project fixture inspection,
production build scanning, and retained-artifact scans. Publication still requires a fresh registry
smoke and release-artifact review; source acceptance does not imply that a package exists on JSR.

## Escape-hatch policy

- An escape hatch exists only for a capability blocked by the public contract and demonstrated by a
  retained use case.
- It is isolated from ordinary product files and named as unsupported.
- It may expose pinned vendor APIs but receives no compatibility guarantee.
- Promotion requires two independent consumers or a critical use case, automated coverage, and a
  decision record describing the new maintenance obligation.
- Node build fallback, raw Jazz access, memory storage, and custom service-worker ownership are not
  public defaults.

## Non-goals through M1

- Publishing packages or the generator.
- Designing a provider-neutral data abstraction.
- Reimplementing Jazz schema, auth, permissions, storage, or sync.
- Building the full inspector, test SDK, invitation UX, push support, or production update UX.
- Claiming support for untested browsers/devices or hiding unavailable durability signals.
- Optimizing bundle size before the selected integration works reliably.

## M1 acceptance checklist

- [x] Optional `.env` and process precedence select the expected mode without printing values.
- [x] Exact Jazz alpha, Deno, Astro, Preact, browser, and executed OS versions are retained;
      physical device versions are explicitly deferred to M3 by the M1 approval.
- [x] Vendor control proves local write, subscription, reload retention, and optional cloud sync.
- [x] Observability inventory maps each promised diagnostic to evidence or removes it.
- [x] Preact decision passes mount/update/unmount/recreate and five-cycle HMR checks.
- [x] Two Astro islands share exactly one client and update each other.
- [x] `deno task dev`, `check`, `test`, `build`, and `preview` work from the checkout.
- [x] Startup/HMR measurements follow the declared protocol.
- [x] OPFS evidence distinguishes durable, unsupported, and memory fallback, retains the complete
      physical checklist for M3, and records the product owner's M1 HTTPS-artifact approval.
- [x] Identity ceremony testing stopped at the security pre-gate; the unsafe alpha passkey design is
      rejected rather than exercised or implied to work.
- [x] Auth evidence rejects the unsafe ceremony, makes a stable isolated RP ID a replacement
      precondition, states that a recovery phrase is a bearer secret, and defines honest first-run,
      backup, and unrecoverable-loss wording.
- [x] Integrated prototype works offline and reloads retained local data without a false transport
      reconnection claim.
- [x] Final build passes server-secret scanning and contains no development-only inspector.
- [x] Every M1-gated promise is validated, revised, or rejected with evidence.
- [x] Final contract and decisions identify all remaining post-M1 work without implying completion.

## M1 falsification map

| Issue                | Primary contract IDs                                      |
| -------------------- | --------------------------------------------------------- |
| #7 Jazz 2 baseline   | DX-LOCAL-01, DX-DUR-01, DX-SYNC-01, DX-OBS-01, DX-TEST-01 |
| #5 Preact strategy   | DX-HMR-01, DX-AUTHOR-01, DX-LEAK-01                       |
| #6 Astro and Deno    | DX-CMD-01, DX-START-01, DX-HMR-01, DX-BUILD-01            |
| #4 OPFS devices      | DX-DUR-01, DX-ERROR-01, DX-OFFLINE-01                     |
| #8 identity/recovery | DX-AUTH-01, DX-DEVICE-01                                  |

## Graduation rule

M1 graduated exactly one integrated application, now named `apps/reference`, containing the approved
Jazz version, Preact strategy, Astro/Deno path, durability policy, and identity model. Rejected
runtime alternatives are removed from the final tree; their evidence remains in decisions and
merge-commit history.

M2 has graduated the single-package command surface, generator, development inspector, and
readiness-first browser-testing helpers. Production PWA/device hardening remains M3 work; remaining
runtime package seams and a second consumer remain M4 work.

## M2 layered graduation

M2 integrated into the `m2` branch as three separately reviewed layers. Each layer passed its own
checks and independent pull-request review before merge. The combined branch is now being
re-reviewed before it may merge into `dev`.

Layer verification runs outside the product and framework surface. An independent agent checks the
exact pushed head in a detached Git worktree, runs `deno task check` plus the layer's applicable
golden journey, and confirms that the retained report names the tested commit. The pull request is a
communication channel for the monitoring reviewer, not a reason to impose a permanent per-push CI
workflow on the framework or generated applications. A layer may merge only when both the clean-room
result and independent review accept that exact head. The final `m2` combination repeats the same
clean-room and review boundary before promotion to `dev`.

| Layer                              | Issues                        | Contract result                                                                                                     |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1 — reference and checkout journey | #9; tracks #11                | Honest checklist CRUD, explicit author/generated boundary, and reusable checkout-mode golden-path evidence.         |
| 2 — public command path            | #13, #14; source gate for #11 | Non-interactive creation plus actionable `dev`/`doctor`; the same journey runs against generated output.            |
| 3 — testing and inspection         | #12, #10                      | Reusable offline/convergence controls and truthful developer diagnostics without leaking machinery into product UI. |

Layer 1 alone did not close #11: checkout-mode evidence was necessary, and Layer 2 subsequently
passed the source-backed generated-project journey. Registry-backed acceptance remains conditional
on explicit publication authorization. Remaining abstraction leaks are tracked in
`docs/m2-abstraction-leaks.md` rather than hidden behind premature package APIs.

Layer 2 has two distinct package gates. Before publication, the generated-project journey invokes
the real local `./create` entrypoint and uses an explicitly test-only file-URL package override so
all generated commands execute from the exact source under review. The default generated output
still pins `jsr:@nzip/lofi` to the manifest version. This source gate does not claim that the
registry command exists: after source acceptance and explicit publication authorization, a
fresh-directory smoke must invoke `deno run -A jsr:@nzip/lofi/create <name>` before #13 and #11 can
close.

Layer 3 keeps inspection and testing semantics distinct. The generated development inspector may
pause a configured Jazz transport, restart the client, and confirmation-gate an OPFS replica clear;
it does not call transport pause "browser offline" and does not infer live connectivity, vendor
queue depth, or leader/follower role. Real network control and readiness-first two-client fixtures
graduate at `@nzip/lofi/testing`. The convergence fixture uses two isolated OPFS replicas with one
identity restored only in memory because the current creator-only permissions do not allow two
distinct identities to edit the same row. See
[ADR 0006](decisions/0006-bound-layer3-inspection-and-testing.md).

Layer 1 keeps M1's `lofi-prototype-<appId>` OPFS namespace so existing device rows remain visible to
the reviewed notes-to-tasks lens. Jazz discovers that lens and its snapshots beside `schema.ts` in
`apps/reference/src/migrations`. `deno task check:migrations` couples the current schema hash,
incoming migration edge, and snapshot; `deno task schema:deploy` is the explicit cloud publication
step for the schema, migration, and permissions bundle.
