# ADR 0005: Publish one `@nzip/lofi` package

Status: accepted\
Date: 2026-07-15

Owner confirmation: FelineStateMachine explicitly confirmed `@nzip/lofi` as the canonical package
after #21 and superseded the earlier `@lofi-cat/*` direction. The `@nzip` JSR scope is the owned
nzip publishing surface and already lists the reserved `@nzip/lofi` package alongside the published
nzip packages. Publication credentials remain a release-time secret, not repository configuration.

## Decision

Use `@nzip/lofi` as lofi's only JSR package. Public framework boundaries remain explicit subpath
exports such as `@nzip/lofi/core`, `@nzip/lofi/sync`, `@nzip/lofi/auth`, `@nzip/lofi/ui`, and
`@nzip/lofi/pwa`. Public tooling graduates under the same package, including the M2 creation command
at `jsr:@nzip/lofi/create` and testing helpers at `@nzip/lofi/testing`.

Do not publish lockstep `@lofi-cat/*` packages. Internal module boundaries and dependency direction
remain enforceable even though those modules share one package version.

## Why

The prototype's modules evolve together around a fast-moving pinned Jazz alpha. One JSR package
provides one version, one publish operation, and direct subpath imports without creating independent
release promises before the seams have been proven by a second application.

## Consequences

- The M2 public create command is `deno run -A jsr:@nzip/lofi/create <name>`.
- Consumers import framework APIs through named subpaths, not the package root.
- Package extraction validates export boundaries, but does not create independently versioned
  artifacts.
- A future split requires evidence that a module needs an independent compatibility or release
  lifecycle.

## Registry evidence

- [JSR `@nzip` scope](https://jsr.io/@nzip), including the reserved `@nzip/lofi` package
