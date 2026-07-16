import { app as schema } from "./schema.ts";

/** Author-owned composition. Vendor URLs and browser drivers remain in generated runtime code. */
export const referenceApp = {
  name: "lofi-prototype",
  databaseName: "lofi-prototype",
  schema,
  storage: "durable" as const,
  // "device-passkey" (default) makes a portable passkey the account (derived from
  // its PRF), so the same key reaches the same account on any device — sign-in is
  // the AccountGate island. "device-local" gives each device its own random
  // account with no sign-in. See docs/auth-identity.md.
  identity: "device-passkey" as "device-local" | "device-passkey",
  // Hostnames you have committed to keeping stable, where a device passkey may be
  // enrolled (exact, or a `*.` suffix pattern). A passkey binds to its origin. Left
  // empty, the origin you are actually served from is trusted so the app works
  // wherever you deploy it — but a passkey breaks if that host later changes, so
  // pin your permanent hostname(s) here before shipping.
  credentialOrigins: [] as readonly string[],
  sync: { adapter: "jazz" as const },
  // Source/home link shown in the starter footer. Point it at your own repo.
  repositoryUrl: "https://github.com/FelineStateMachine/lofi",
};
