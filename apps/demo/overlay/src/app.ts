import { defineLofiApp } from "@nzip/lofi";
import { app as schema } from "./schema.ts";

/** Author-owned composition for the hosted demo at demo.lofi.host. */
export const app = defineLofiApp({
  name: "lofi-demo",
  databaseName: "lofi-demo",
  schema,
  storage: "durable" as const,
  // Identity is local-first: first boot opens a private, on-device account with
  // no sign-in. The demo compiles without a managed Jazz app, so data stays in
  // this browser unless the visitor enrolls their own sync ticket through the
  // AccountGate island.
  //
  // Device credentials (WebAuthn/PRF) bind to their origin; the demo's
  // production hostname is pinned so passkeys can enroll there, while
  // localhost keeps working for development without configuration.
  credentialOrigins: ["demo.lofi.host"] as readonly string[],
  sync: { adapter: "jazz" as const },
  repositoryUrl: "https://github.com/FelineStateMachine/lofi",
});
