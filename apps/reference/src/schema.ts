import { s } from "@nzip/lofi/schema";

// Author-owned schema, declared through the lofi schema surface; UI islands
// consume it only through public @nzip/lofi seams (see
// tests/author-boundary_test.ts).
const schema = {
  tasks: s.table({
    text: s.string(),
    completed: s.boolean(),
    createdAt: s.timestamp(),
  }),
};

export const app = s.defineApp(schema);
