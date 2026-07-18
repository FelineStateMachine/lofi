# Binary and structured payloads

Two column types carry non-scalar values: `s.bytes()` for binary data and `s.json()` for structured
data. Both round-trip through the engine byte- and shape-exact — verified in
`package/schema/conformance_test.ts`.

## Declare the payload columns

```ts
// src/schema.ts
import { s } from "@nzip/lofi/schema";

export const app = s.defineApp({
  attachments: s.table({
    fileName: s.string(),
    thumbnail: s.bytes(),
    metadata: s.json(),
  }),
});
```

```ts
const attachment = await db.insert(app.attachments, {
  fileName: "cover.png",
  thumbnail: new Uint8Array(await blob.arrayBuffer()),
  metadata: { width: 320, height: 180, palette: ["#282828", "#ebdbb2"] },
}).wait({ tier: "global" });
// Reads return the same Uint8Array bytes and the same nested JSON shape.
```

## Choosing between them

- **`s.bytes()`** stores an opaque `Uint8Array`: thumbnails, hashes, encrypted blobs, anything the
  app treats as bytes. One pinned constraint: payloads under 32 bytes are unreliable in the current
  alpha — pad short values, or store small binary-ish data as `s.json()` until upstream fixes it.
- **`s.json()`** stores any JSON value and reads back the same nested shape. Reach for it when the
  data is a document the app consumes whole. When you need to _filter_ on a field, promote that
  field to its own typed column instead — `where` addresses columns, not JSON internals.
- **`s.array(inner)`** sits between the two: use it when the value is a flat list of one typed
  element and `s.json()` when the shape nests.

Rows travel through sync whole, so a payload column is for data sized like a row — icons and
metadata, not video. Large media belongs outside the table with a payload column holding the
reference (hash, URL, or identifier).
