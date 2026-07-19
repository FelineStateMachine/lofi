import { s } from "@nzip/lofi/schema";

// Author-owned schema, declared through the lofi schema surface; UI islands
// consume it only through public @nzip/lofi seams. The demo tracks fire
// incidents instead of the starter's tasks, and declares the table with
// s.privateTable so every column is encrypted at rest by default.
const schema = {
  incidents: s.privateTable("incidents", {
    title: s.string(),
    severity: s.enum("smolder", "burn", "melt"),
    status: s.enum("burning", "contained", "out"),
    openedAt: s.timestamp(),
  }),
};

export const app = s.defineApp(schema);
