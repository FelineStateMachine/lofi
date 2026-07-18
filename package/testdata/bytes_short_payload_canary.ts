// Child process for the short-bytes canary in
// package/schema/conformance_test.ts. In jazz-tools@2.0.0-alpha.53 a short
// byte payload insert has been observed succeeding, failing with the
// flat-history encoder error, and hanging — context-dependent — so it runs
// behind a race in a process that force-exits.
import { createPolicyTestApp } from "jazz-tools/testing";
import { s } from "../schema/mod.ts";

const expectLike = (value: unknown) => ({
  toThrow() {
    if (typeof value === "function") value();
  },
  not: {
    toThrow() {
      if (typeof value === "function") value();
    },
  },
});

const app = s.defineApp({ blobs: s.table({ value: s.bytes() }) });
const permissions = s.definePermissions(app, ({ policy }) => {
  policy.blobs.allowInsert.always();
  policy.blobs.allowRead.always();
  policy.blobs.allowUpdate.always();
  policy.blobs.allowDelete.always();
});

const testApp = await createPolicyTestApp(app, permissions, expectLike);
const db = testApp.as({ user_id: "canary", claims: {}, authMode: "local-first" });

const outcome = await Promise.race([
  db.insert(app.blobs, { value: new Uint8Array([1, 2]) }).wait({ tier: "global" }).then(
    () => "short-bytes:OK",
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return `short-bytes:ERROR:${message}`;
    },
  ),
  new Promise<string>((resolve) => setTimeout(() => resolve("short-bytes:HUNG"), 8_000)),
]);
console.log(outcome);
Deno.exit(0);
