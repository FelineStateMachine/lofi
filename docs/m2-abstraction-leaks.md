# M2 abstraction-leak ledger

Status: active during M2\
Last reviewed: 2026-07-15

This ledger keeps the Layer 1 reference application honest. A listed leak is not a supported lofi
API; it is a concrete input to the layer that owns removing or productizing it.

| Leak retained in Layer 1                                                                     | Why it remains                                                                                                          | Owning issue                  | Graduation evidence                                                                                                    |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Repository-root wrappers own `dev`, `build`, preview, environment loading, and secret scans. | Extracting commands before the reference journey is executable would freeze an untested project shape.                  | #13, #14                      | A generated directory runs its own documented tasks without repository-relative paths.                                 |
| `schema.ts` and `permissions.ts` import the pinned Jazz schema DSL directly.                 | M1 rejected inventing a second schema language without a proven ergonomic gain.                                         | Later API extraction after M2 | A second real application demonstrates a smaller stable facade, or the direct DSL is accepted explicitly.              |
| `app.ts` uses a provisional plain configuration object and the Jazz schema value.            | Layer 1 needs configuration-as-data but does not yet have two consumers that justify a public factory or exported type. | #13                           | The generator emits the approved configuration without raw client, transport, or environment plumbing.                 |
| Runtime cardinality and lifecycle evidence use a development-only global probe.              | Product UI must stay clean while the browser journey still needs deterministic evidence.                                | #10                           | The inspector exposes the same truthful signals through a supported development surface and is absent from production. |
| The checkout golden path owns process/browser orchestration at repository scope.             | Layer 1 proves the journey before defining a reusable testing package.                                                  | #12                           | Offline and multi-client helpers are callable from generated-project tests with readiness-based APIs.                  |
| Cloud/global settlement is observable per write, but live socket state is not.               | Jazz alpha.53 exposes mutation durability but no supported connection-state signal.                                     | #10, #12                      | Inspector/tests distinguish configured mode, local durability, global durability, and unavailable live detail.         |

Deleting an entry requires retained evidence in the owning issue or a decision record accepting the
behavior as an intentional public boundary.
