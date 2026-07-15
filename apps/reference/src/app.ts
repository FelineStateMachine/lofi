import { app as schema } from "./schema.ts";

/** Author-owned composition. Vendor URLs and browser drivers remain in generated runtime code. */
export const referenceApp = {
  name: "lofi checklist",
  // Keep the M1 OPFS namespace so the notes-to-tasks migration can open and
  // transform existing device data instead of presenting an empty database.
  databaseName: "lofi-prototype",
  schema,
  storage: "durable" as const,
  identity: "device-local" as const,
  sync: { adapter: "jazz" as const },
};
