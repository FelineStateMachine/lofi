// The sharedFieldAccess template against the real pinned server: the
// compiled directory policy is world-readable with self-only writes, and
// encrypted columns are refused in the directory's template positions.

import { createDb, schema as s } from "jazz-tools";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";
import { defineAccessPolicies, sharedFieldAccess, sharedFieldDirectoryTable } from "./mod.ts";
import { s as lofiSchema } from "../schema/mod.ts";
import { clearEncryptedColumnRegistry } from "../schema/encrypted.ts";
import { assert } from "../runtime/test-assert.ts";

const app = s.defineApp({
  keyDirectory: sharedFieldDirectoryTable(),
});
const permissions = defineAccessPolicies(app, [
  sharedFieldAccess({ directory: app.keyDirectory }),
]);

function secret(fill: number): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(fill)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function within<T>(operation: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

Deno.test("the compiled directory policy is world-readable with self-only writes", async () => {
  const server = await startLocalJazzServer({ allowLocalFirstAuth: true });
  await deploy({
    appId: server.appId,
    serverUrl: server.url,
    adminSecret: server.adminSecret,
    schema: app,
    permissions,
  });
  const alice = await createDb({
    appId: server.appId,
    serverUrl: server.url,
    secret: secret(1),
    userBranch: "main",
    driver: { type: "memory" },
  });
  const bob = await createDb({
    appId: server.appId,
    serverUrl: server.url,
    secret: secret(2),
    userBranch: "main",
    driver: { type: "memory" },
  });
  try {
    const aliceId = alice.getAuthState().session?.user_id as string;
    const bobId = bob.getAuthState().session?.user_id as string;
    assert(Boolean(aliceId && bobId && aliceId !== bobId), "test principals were not isolated");

    await within(
      alice.insert(app.keyDirectory, {
        user_id: aliceId,
        algo: "x25519-v1",
        public_key: "alice-pub",
        fingerprint: "alice-fp",
      }).wait({ tier: "global" }),
      "alice publishes",
    );
    const seenByBob = await within(
      bob.all(app.keyDirectory.where({ user_id: aliceId })),
      "bob reads alice's row",
    );
    assert(
      seenByBob.length === 1 && seenByBob[0].public_key === "alice-pub",
      `the directory must be world-readable (saw ${seenByBob.length})`,
    );

    let denied = false;
    try {
      await within(
        bob.insert(app.keyDirectory, {
          user_id: aliceId,
          algo: "x25519-v1",
          public_key: "evil-pub",
          fingerprint: "evil-fp",
        }).wait({ tier: "global" }),
        "bob impersonates alice",
      );
    } catch {
      denied = true;
    }
    assert(denied, "a foreign user_id insert must be denied");
  } finally {
    await Promise.allSettled([
      within(alice.logout(), "Alice cleanup", 3_000),
      within(bob.logout(), "Bob cleanup", 3_000),
    ]);
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
  }
});

Deno.test("a directory with a sealed column fails configuration", () => {
  clearEncryptedColumnRegistry();
  try {
    const sealedApp = lofiSchema.defineApp({
      keyDirectory: lofiSchema.table({
        user_id: lofiSchema.encryptedText("keyDirectory.user_id"),
        algo: lofiSchema.string(),
        public_key: lofiSchema.string(),
        fingerprint: lofiSchema.string(),
      }),
    });
    let message = "";
    try {
      defineAccessPolicies(sealedApp, [
        sharedFieldAccess({ directory: sealedApp.keyDirectory }),
      ]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("encrypted") && message.includes("user_id"),
      `a sealed directory column compiled: ${message || "no error"}`,
    );
  } finally {
    clearEncryptedColumnRegistry();
  }
});
