# Direct sharing example

Define the raw resource and the conventional grant table:

```ts
import { schema as s } from "jazz-tools";
import { sharedGrantTable } from "@nzip/lofi/access";

export const app = s.defineApp({
  notes: s.table({ title: s.string(), body: s.string() }),
  noteGrants: sharedGrantTable("notes"),
});
```

Apply the narrow policy:

```ts
import { defineAccessPolicies, sharedAccess } from "@nzip/lofi/access";
import { app } from "./schema.ts";

export default defineAccessPolicies(app, [
  sharedAccess({ resource: app.notes, grants: app.noteGrants }),
]);
```

Create typed operations and pass the recipient's non-secret, app-scoped sharing identity:

```ts
import { createSharingOperations } from "@nzip/lofi/access";
import { app } from "./schema.ts";

const notes = createSharingOperations({ resource: app.notes, grants: app.noteGrants });
await notes.share(note.id, recipientIdentity, "read");
await notes.share(note.id, recipientIdentity, "edit");
await notes.revoke(note.id, recipientIdentity);
```

Managed sync is required. A read grant permits reads, an edit grant permits reads and updates, and
only the owner can delete or manage grants. Invitation delivery and user discovery remain app
concerns.
