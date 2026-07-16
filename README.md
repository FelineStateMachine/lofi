# lofi

**A local-first mobile PWA meta-framework, built as an honest prototype.**

Write a schema, build Preact islands, ship an installable offline-capable app. The UI always
hydrates from local data, identity never waits on a server, and the sync module is the only network
surface an app developer ever sees.

Built on [Jazz 2](https://jazz.tools) (CRDT data + sync) · [Preact](https://preactjs.com) islands in
[Astro](https://astro.build) · the [Deno](https://deno.com) toolchain.

> **Status: working prototype, pre-release.** Nothing is published yet. M0 (DevX contract) and M1
> (feasibility) are complete; all three M2 source layers are merged on `m2` and undergoing combined
> promotion review. See the [roadmap](#roadmap).

## Why lofi

- **Local-first without the plumbing.** Product code touches schema, config, islands, styles, and
  tests — never providers, workers, transports, or service-worker internals
  ([DX-AUTHOR-01, DX-LEAK-01](docs/devx-contract.md#measurable-promises)).
- **Honest by construction.** Durable storage never silently degrades to memory; diagnostics only
  claim what the underlying APIs can actually observe; identity wording matches real custody and
  recovery semantics.
- **Mobile PWA first.** Platform floors (Android Chrome 148+, iOS Safari 16.4+) are enforced boot
  gates, not advisory footnotes. Unsupported browsers get an explicit answer, never silent data
  loss.

## The north star

When every milestone below has landed, this is the entire onboarding experience:

```sh
deno run -A jsr:@nzip/lofi/create my-app
cd my-app
deno task dev
```

From there a developer makes a retained local write, reloads it, works offline, runs checks, builds,
previews, and opens the same stable secure origin on a physical phone — with Deno as the only
required global runtime and a command surface of exactly seven verbs: `create`, `dev`, `doctor`,
`check`, `test`, `build`, `preview`.

## Try it today (checkout journey)

The `m2` branch contains the accepted source generator, package-owned commands, development
inspector, and browser-testing helpers. The package is not published until explicitly authorized and
the registry-backed smoke passes, so the currently available journey runs from a checkout:

```sh
git clone https://github.com/FelineStateMachine/lofi.git
cd lofi
deno task dev
```

- **Deno 2.9+** is the only required global runtime.
- **No `.env` means local-only mode**, stated explicitly at boot. For cloud sync, copy
  `.env.example` and set the public `JAZZ_APP_ID`/`JAZZ_SERVER_URL` pair. Server-only secrets never
  reach client output — this is tested, not hoped.
- From `deno task dev` you should reach a retained local write in under 60 seconds
  ([DX-PROTOTYPE-01](docs/devx-contract.md#measurable-promises)).

### Command surface

| Command             | What it does today                                                       |
| ------------------- | ------------------------------------------------------------------------ |
| `deno task dev`     | Serves the prototype; prints URL plus storage, identity, and sync state. |
| `deno task check`   | Format, lint, type, Astro, env-contract, and secret-leak checks.         |
| `deno task test`    | Deterministic local-first tests (no hand-timed sleeps).                  |
| `deno task build`   | Production build through the supported Deno path.                        |
| `deno task preview` | Serves the production build.                                             |

`create` and `doctor` have graduated through the source-backed generated-project golden journey and
clean-room review. The public JSR invocation remains unavailable until publication and its
registry-backed smoke pass; the output contracts are specified in the
[DevX contract](docs/devx-contract.md#canonical-command-surface-and-output-contract).

## How this repository works

Development here is **contract-driven**: the product is a set of falsifiable promises, and code
graduates only by producing evidence against them.

1. **[The DevX contract](docs/devx-contract.md)** defines measurable promises with IDs (like
   `DX-LOCAL-01`), budgets, and statuses (`proposed → validated / revised / rejected`).
2. **[Decision records](docs/decisions/)** capture each experiment: question, exact versions,
   control, procedure, retained evidence, and the resulting contract delta. A spike is complete when
   it supports a decision — including a negative one — not when a demo renders once.
3. **[Milestones](https://github.com/FelineStateMachine/lofi/milestones)** gate scope. Issues carry
   `area:*`, `type:*`, and `priority:p0–p2` labels; p0 blocks the golden path.

Notable honest outcomes so far: the Jazz 2 alpha passkey-backup ceremony was **rejected** on
security grounds rather than demoed
([decision 0004](docs/decisions/0004-reject-alpha53-passkey-backup.md)), and live transport state is
reported as _unavailable_ rather than faked, because the pinned API exposes no supported signal.

## Roadmap

| Milestone                       | Goal                                                                                                 | Status              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------- |
| **M0 — DevX contract**          | Define the golden path, command surface, environment contract, and measurable acceptance criteria.   | ✅ Done             |
| **M1 — Feasibility spikes**     | Prove Jazz 2, Preact, OPFS, identity, Astro islands, and Deno behavior with go/no-go decisions.      | ✅ Done             |
| **M2 — DevX vertical slice**    | `create`, `dev`, `doctor`, diagnostics, inspector, and testing workflows around a reference app.     | 🧪 Promotion review |
| **M3 — Mobile PWA hardening**   | Install, persistence, offline cold start, lifecycle recovery, and physical-device validation.        | ⏳ Queued           |
| **M4 — Runtime API extraction** | Extract remaining proven runtime seams as `@nzip/lofi` subpaths; validate them through a second app. | ⏳ Queued           |

The definition of done for the whole prototype is the [north star](#the-north-star) journey passing
its contract budgets end-to-end, on real devices.

## Repository map

```text
lofi/
├── docs/
│   ├── devx-contract.md   # The product contract: promises, budgets, statuses
│   └── decisions/         # Evidence-backed decision records (ADR-style)
├── apps/reference/        # The integrated app graduated from M1 and reshaped in M2
├── package/               # The single @nzip/lofi package source and generated-project commands
├── spikes/                # M1 feasibility experiments, kept for evidence
├── tools/                 # Deno tasks: env contract, secret scanning, runners
├── init.md                # Original research plan — input, not the contract
├── deno.json              # Workspace tasks and pinned toolchain
└── jsr.json               # One package name, version, export map, and publish manifest
```

## Stack

| Layer      | Choice                                        | Pinned at           |
| ---------- | --------------------------------------------- | ------------------- |
| Data/sync  | jazz-tools 2.0 alpha (exact pin), OPFS        | `2.0.0-alpha.53`    |
| UI runtime | Preact islands, `client:only`, thin adapter   | Preact 10 / Astro 7 |
| Shell      | Astro, fully prerendered, static-through-Deno | Astro 7             |
| Toolchain  | Deno tasks + npm-compat                       | Deno 2.9            |

Version pins are deliberate: the data layer is an alpha, so every bump is a reviewed decision, and
`docs/decisions/` records what each pin was verified to do.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow: how promises, evidence, and decision
records fit together, what `deno task check` enforces, and how issues and milestones are organized.
