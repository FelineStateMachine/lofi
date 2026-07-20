# Generated mirror — do not edit

Every `.txt` file in this directory is a byte-identical, generated copy of a `.ts`/`.tsx` starter
file in `apps/reference/`. The mirror exists only for publishing: the registry rewrites the
specifiers inside every published module, so the generator reads the starter's TypeScript from these
non-module copies instead.

Edit the source under `apps/reference/`, then refresh the mirror with the
`deno task test:update:create` task. A direct edit here cannot survive `deno task check` — the
mirror test fails any file that drifts from its source.
