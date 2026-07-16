import { app as schema } from "./schema.ts";

/** Author-owned composition. Vendor URLs and browser drivers remain in generated runtime code. */
export const referenceApp = {
  name: "lofi-prototype",
  databaseName: "lofi-prototype",
  schema,
  storage: "durable" as const,
  identity: "device-local" as const,
  // Hostnames you have committed to keeping stable, where a device passkey may be
  // enrolled (exact, or a `*.` suffix pattern). A passkey binds to its origin, so
  // enrollment is refused anywhere else. Add yours before shipping device auth.
  credentialOrigins: [] as readonly string[],
  sync: { adapter: "jazz" as const },
};
