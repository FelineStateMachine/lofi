import { schema as s } from "jazz-tools";

// Author-owned schema. This file and permissions.ts are the starter's two
// deliberate raw-Jazz surfaces; UI islands consume the schema only through
// public @nzip/lofi seams (see tests/author-boundary_test.ts).
const schema = {
  tasks: s.table({
    text: s.string(),
    completed: s.boolean(),
    createdAt: s.timestamp(),
  }),
};

export const app = s.defineApp(schema);
