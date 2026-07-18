import { schema as s } from "jazz-tools";
import {
  AccessError,
  createSharingOperations,
  decodeSharingIdentity,
  encodeSharingIdentity,
  sharedGrantTable,
} from "./mod.ts";
import { assert } from "../runtime/test-assert.ts";

const app = s.defineApp({
  docs: s.table({ title: s.string() }),
  grants: sharedGrantTable("docs"),
});

Deno.test("sharing identities round-trip only inside the configured app", () => {
  const identity = encodeSharingIdentity("stable-jazz-principal");
  assert(
    decodeSharingIdentity(identity) === "stable-jazz-principal",
    "identity did not round-trip",
  );
  let code = "";
  try {
    decodeSharingIdentity("lofi1:different-app:principal");
  } catch (error) {
    code = error instanceof AccessError ? error.code : "unexpected";
  }
  assert(code === "invalid-identity", "cross-app identity was accepted");
});

Deno.test("sharing identities tolerate copy/paste padding but never inner whitespace", () => {
  const identity = encodeSharingIdentity("stable-jazz-principal");
  assert(
    decodeSharingIdentity(`  ${identity}\n`) === "stable-jazz-principal",
    "surrounding whitespace from copy/paste must not change the decoded principal",
  );
  // A grant recorded for a whitespace-bearing principal looks active to the
  // owner but never matches the recipient's account — reject at both ends.
  let decoded = "";
  try {
    decodeSharingIdentity(identity.replace("principal", "prin cipal"));
  } catch (error) {
    decoded = error instanceof AccessError ? error.code : "unexpected";
  }
  assert(decoded === "invalid-identity", "inner whitespace in the principal was accepted");
  let encoded = "";
  try {
    encodeSharingIdentity("principal with spaces");
  } catch (error) {
    encoded = error instanceof AccessError ? error.code : "unexpected";
  }
  assert(encoded === "invalid-identity", "a whitespace-bearing principal must not encode");
});

Deno.test("shared operations reject managed-sync work before touching a local-only runtime", async () => {
  const operations = createSharingOperations({ resource: app.docs, grants: app.grants });
  let code = "";
  try {
    await operations.share("resource", encodeSharingIdentity("recipient"), "read");
  } catch (error) {
    code = error instanceof AccessError ? error.code : "unexpected";
  }
  assert(code === "sync-required", "local-only sharing did not report its sync precondition");
});
