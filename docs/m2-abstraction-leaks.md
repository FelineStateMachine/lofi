# M2 abstraction-leak ledger

Status: active during M2\
Last reviewed: 2026-07-15

This ledger keeps the Layer 1 reference application honest. A listed leak is not a supported lofi
API; it is a concrete input to the layer that owns removing or productizing it.

| Leak retained in Layer 1                                                                              | Why it remains                                                                                                                                                 | Owning issue                  | Graduation evidence                                                                                              |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Repository-root wrappers still own the checkout journey; generated commands now live in `@nzip/lofi`. | The generated path is implemented without repository-relative paths, but this leak remains listed until exact-head generated golden evidence is retained.      | #13, #14                      | A generated directory runs its own documented tasks without repository-relative paths.                           |
| `schema.ts` and `permissions.ts` import the pinned Jazz schema DSL directly.                          | M1 rejected inventing a second schema language without a proven ergonomic gain.                                                                                | Later API extraction after M2 | A second real application demonstrates a smaller stable facade, or the direct DSL is accepted explicitly.        |
| `app.ts` uses a provisional plain configuration object and the Jazz schema value.                     | Layer 1 needs configuration-as-data but does not yet have two consumers that justify a public factory or exported type.                                        | #13                           | The generator emits the approved configuration without raw client, transport, or environment plumbing.           |
| Live socket state, vendor queue depth, and multi-tab role remain unavailable.                         | Jazz alpha.53 exposes mutation durability but no supported signal for these details; ADR 0006 accepts explicit unavailability instead of fabricated precision. | Jazz baseline review          | A later Jazz pin exposes supported signals, or the unavailable boundary remains an intentional product contract. |

## Graduated in Layer 3

| Former leak                                                               | Graduated surface                                                                                                                                      | Evidence                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime cardinality and lifecycle evidence used a development-only probe. | The generated dev-only inspector owns redacted diagnostics and safe actions; production builds contain no inspector marker, bridge, route, or chunk.   | [ADR 0006](decisions/0006-bound-layer3-inspection-and-testing.md), inspector unit coverage, and generated golden restart/clear/production-exclusion assertions in `tools/golden_path.ts`. |
| Browser orchestration existed only in the repository checkout journey.    | `@nzip/lofi/testing` exports readiness, offline restoration, two-client identity isolation, convergence coordination, and sanitized failure artifacts. | [ADR 0006](decisions/0006-bound-layer3-inspection-and-testing.md), generated subpath-resolution coverage, real Chromium integration, and the cloud two-replica convergence gate.          |

Deleting an entry requires retained evidence in the owning issue or a decision record accepting the
behavior as an intentional public boundary.
