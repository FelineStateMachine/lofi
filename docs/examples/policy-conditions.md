# Policy conditions on typed columns

The access templates ([direct sharing](shared.md), [fixed-role group](group.md)) cover the common
collaboration shapes. When they don't fit, shape the policy yourself with `s.definePermissions` —
the same surface the generated starter uses for its owner-only default. Conditions match on magic
columns (`$createdBy`) and on your own typed columns alike; both are conformance-verified.

## Gate rows on an application column

A moderation flow where drafts are private until published, and published rows become undeletable:

```ts
// src/permissions.ts
import { s } from "@nzip/lofi/schema";
import { app } from "./schema.ts";

export default s.definePermissions(app, ({ policy, session, anyOf }) => {
  policy.posts.allowInsert.always();
  // Readable when published, or always by the author.
  policy.posts.allowRead.where(anyOf([
    { published: true },
    { $createdBy: session.user_id },
  ]));
  policy.posts.allowUpdate.where({ $createdBy: session.user_id });
  // Only unpublished drafts may be deleted.
  policy.posts.allowDelete.where({ published: false, $createdBy: session.user_id });
});
```

`anyOf` composes alternatives: a row enters live queries when any branch matches, and an object
condition with several keys requires all of them. Policy conditions are the filter of record — a row
that fails them never reaches the client, so the UI does not need defensive re-checks.

## Let the UI ask what it may do

Rather than re-deriving the policy in components, select the permission introspection columns and
render from them:

```ts
import { s } from "@nzip/lofi/schema";

const posts = useLiveQuery(
  () =>
    app.schema.posts
      .select("title", "published", ...s.permissionIntrospectionColumns)
      .where({}),
  [],
);
// Each row carries $canRead, $canEdit, and $canDelete, evaluated for the
// current session against the deployed policy.
```

A row's `$canDelete` is `false` exactly when the delete rule above rejects it, so a delete button
can disable itself without duplicating the condition. If the policy changes later, the UI follows
the deployment instead of drifting.

Test custom policies the same way as the templates: at least two isolated identities, one row that
each rule admits and one it rejects, and a rejected mutation surfacing through the mutation hook's
`error` state.
