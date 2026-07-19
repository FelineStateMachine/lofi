import { s } from "@nzip/lofi/schema";

// Author-owned schema, declared through the lofi schema surface; UI islands
// consume it only through public @nzip/lofi seams. The demo declares its one
// table with s.privateTable, so every column is encrypted at rest by default.
const schema = {
  tasks: s.privateTable("tasks", {
    text: s.string(),
    completed: s.boolean(),
    createdAt: s.timestamp(),
  }),
};

export const app = s.defineApp(schema);
