# Group-creator authority under Jazz alpha.53 policy negation limits

Date: 2026-07-17\
Reviewed dependency: `jazz-tools@2.0.0-alpha.53`\
Decision: document permanent creator authority; grant direct creator delete; revisit on upgrade

## Problem

The `groupAccess` template gives a group's creator `$createdBy` update authority on the group row so
they can insert the first admin membership (membership management derives from group-update via
`allowedTo.update("groupId")`). That authority never lapses: a creator who is later demoted or
removed by other admins can restore their own admin membership at any time. Separately, a failed
first-admin insert used to strand an undeletable orphan group, because rollback deletion required
the admin membership that had just failed to insert.

The intended fix was a **bootstrap window**: creator authority over the group row holds only while
the group has no admin membership. That requires a negated existence condition — "no admin
membership row exists for this group".

## Exact alpha.53 engine behavior

The policy IR (`schema.js` `PolicyExpr`) declares `{ type: "Not", expr }`, the permissions compiler
passes raw IR through, and `schema-permissions.js` serializes `Not` for the wasm core. The core,
however, **silently drops `Not` around existence conditions**. Probed against `createPolicyTestApp`
with a two-table group/members app, rule under test on `allowDelete`:

| Probe                                             | Expected   | alpha.53 result                 |
| ------------------------------------------------- | ---------- | ------------------------------- |
| `Not(True)` / `Not(False)`                        | deny/allow | correct                         |
| `Not(Cmp column = literal)`                       | deny       | correct                         |
| `Exists(...)` / `ExistsRel(...)` (pos + neg ctrl) | —          | correct                         |
| `Not(Exists(...))`, no matching rows              | allow      | **denied**                      |
| `Not(ExistsRel(...))`, matching row present       | deny       | **allowed**                     |
| `And(True, Not(ExistsRel(...)))`, row present     | deny       | **allowed**                     |
| LEFT-join + `IsNull` anti-join via `ExistsRel`    | allow      | denied (join not null-extended) |

`Not` over `Exists`/`ExistsRel` evaluates as if the `Not` were absent — a silent wrong-direction
result, not an error. The `RelExpr` LEFT-join anti-join alternative does not produce null-extended
rows in policy evaluation, so absence-of-rows is not expressible at all in this engine.

## Decision

- **Creator authority over the group row stays permanent and becomes a documented trust property**
  of the template: the creator can always update the group and therefore always restore their own
  admin membership. Products that need creator-proof handover cannot get it from this template on
  this engine.
- **The creator additionally receives direct `allowDelete` on their own group rows.** This grants no
  new authority — a creator can already self-bootstrap an admin membership and delete transitively —
  and it lets `createGroup` roll back cleanly when the first-admin insert fails, removing the
  orphan-group failure mode.
- **An engine canary test** (`access_security_test.ts`, "engine canary") asserts the broken
  behavior: a `Not(ExistsRel(...))` delete guard that a correct engine would deny. When a jazz-tools
  upgrade fixes negation, the canary fails, signalling that the bootstrap-window design in this
  record should replace permanent creator authority:
  `allowUpdate/allowDelete = anyOf([isAdmin, allOf([$createdBy, Not(Exists(admin membership))])])`,
  which also preserves creator recovery of admin-less groups.

## Trust and fallback

- The template's authority model is: fixed roles for members, plus a permanent creator superseat.
  The sharing UI and docs state this; it must not be presented as revocable admin membership.
- Upstream: the dropped-negation behavior is a jazz-tools core issue worth reporting; until then, no
  lofi policy may rely on `Not` around `Exists`/`ExistsRel`.

## Evidence sources

- Probe suite output recorded in this record's table (2026-07-17, Deno harness
  `createPolicyTestApp`, pinned npm cache for `jazz-tools@2.0.0-alpha.53`).
- `dist/permissions/index.js` (raw IR pass-through), `dist/schema-permissions.js` (`Not`
  serialization), `dist/ir.d.ts` (`PolicyExprV2.Not`, `RelExpr`).
