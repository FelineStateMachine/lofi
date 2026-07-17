import { app as schema } from "./schema.ts";

/** Author-owned composition. Vendor URLs and browser drivers remain in generated runtime code. */
export const referenceApp = {
  name: "lofi-prototype",
  databaseName: "lofi-prototype",
  schema,
  storage: "durable" as const,
  // Identity is local-first: first boot opens a private, on-device account with
  // no sign-in. When a managed Jazz app is configured (JAZZ_APP_ID / JAZZ_SERVER_URL —
  // see `deno task jazz:provision`), the AccountGate island lets the user elect to
  // back up and sync it, and recover it from a phrase. See the framework's
  // `docs/sync-and-recovery.md` guide.
  //
  // Hostnames you have committed to keeping stable, for the optional device-credential
  // primitive in `src/_lofi/auth.ts` (WebAuthn/PRF at-rest encryption). A credential
  // binds to its origin; left empty, the served origin is trusted. Pin your permanent
  // hostname(s) here before relying on a credential across a host change.
  credentialOrigins: [] as readonly string[],
  sync: { adapter: "jazz" as const },
  // Source/home link shown in the starter footer. Point it at your own repo.
  repositoryUrl: "https://github.com/FelineStateMachine/lofi",
};
