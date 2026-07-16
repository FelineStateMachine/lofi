import { app as schema } from "./schema.ts";

/** Author-owned composition. Vendor URLs and browser drivers remain in generated runtime code. */
export const referenceApp = {
  name: "lofi-prototype",
  databaseName: "lofi-prototype",
  schema,
  storage: "durable" as const,
  identity: "device-local" as const,
  sync: { adapter: "jazz" as const },
};
