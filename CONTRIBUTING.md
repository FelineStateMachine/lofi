# Contributing to lofi

This repository runs on a small number of strict habits. They exist so that a prototype built on an
alpha data layer stays honest about what actually works.

## Prerequisites

- **Deno 2.9+** — the only required global runtime.
- **Git** — a contributor prerequisite for this repository journey (generated apps will not need
  it).

## The one command that gates everything

```sh
deno task check
```

This runs formatting, linting, and the deterministic test suite. Deno type-checks the imported
application and runtime modules as part of the suite, which also includes the environment contract
and secret-leak scan. A change is not ready for review until it passes locally. There are no hidden
global tools.

Before publishing, also inspect the package artifact:

```sh
deno task publish:dry --allow-dirty
```

## Contract-driven changes

The product is defined by [docs/devx-contract.md](docs/devx-contract.md) — a table of falsifiable
promises with IDs, budgets, and statuses. Work relates to it in one of three ways:

1. **Implements a promise.** Cite the contract IDs (e.g. `DX-LOCAL-01`) in the issue and PR, and
   show the evidence that the budget is met.
2. **Changes a promise.** Evidence disproved or narrowed it — update the contract row
   (`validated / revised / rejected`) in the same PR and record the delta in a decision record.
3. **Touches no promise.** Say so; small mechanical changes do not need contract ceremony.

### Decision records

Time-boxed experiments (`type: spike`) must produce a record in
[docs/decisions/](docs/decisions/README.md) with the shape defined there: question, contract IDs,
exact versions, control, procedure, retained evidence, decision, contract delta, follow-up.

Two rules worth repeating:

- A spike is complete when it supports a decision — **including a negative decision** — not when a
  demo renders once.
- A search summary without a stable primary source is not evidence. Cite documentation, changelog,
  source, or retained device artifacts.

## Issues, labels, milestones

- **Milestones** gate scope: M2 (DevX vertical slice) → M3 (mobile PWA hardening) → M4 (framework
  extraction). Every substantive issue belongs to one.
- **Labels:**
  - `priority: p0` blocks the golden path or the next milestone; `p1` is important milestone work;
    `p2` is follow-up.
  - `area: jazz | pwa | tooling | framework | auth` locates the subsystem.
  - `type: spike` means time-boxed with an explicit decision; `type: devx` means developer
    experience and authoring workflow.
- Issue and PR templates in `.github/` prompt for contract IDs and evidence — filling those fields
  is what makes review fast.

## Branches and pull requests

- Branch from `main`; agent-driven work uses the `agent/<scope>` prefix, human work can use any
  clear prefix (`chore/`, `docs/`, `fix/`).
- Merge to `main` happens through a PR. Keep PRs scoped to one milestone concern; link the issues
  they close.
- The PR description should let a reviewer verify claims without re-deriving them: what was run,
  what was observed, where retained evidence lives.

## Hard boundaries (do not relax casually)

These are contract commitments, not style preferences:

- **Secrets:** `JAZZ_ADMIN_SECRET` and `BACKEND_SECRET` are server-only — never projected into
  client config, logs, examples with values, or build output. The secret scan enforces this.
- **Silent degradation is forbidden:** durable storage never quietly becomes memory-only;
  diagnostics never claim signals the pinned vendor API does not expose.
- **The author boundary:** product UI never imports raw Jazz, workers, transports, or Workbox
  config. If a change needs that, it belongs in the runtime layer or an explicitly named escape
  hatch (see the [escape-hatch policy](docs/devx-contract.md#escape-hatch-policy)).
- **Version pins are decisions:** bumping the Jazz alpha (or any pinned tool) requires re-running
  the affected evidence and a decision record if behavior changed.
