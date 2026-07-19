// The sharedFieldAccess template against the real pinned server: the
// compiled directory policy is world-readable with self-only writes, and
// encrypted columns are refused in the directory's template positions.

import { createDb, schema as jazzSchema, schema as s } from "jazz-tools";
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

// ENGINE CANARY (alpha.53): rows whose read policy is an exists-based
// function condition never propagate to other accounts over real sync, while
// always() and direct object conditions propagate immediately. The
// collaboration templates' cross-account reads are bounded by this; the
// shared-field design routes around it (wrapped keys use a direct recipient
// condition, the directory reads always()). This test pins the gap: when an
// engine bump fixes propagation, it fails loudly — revisit the read-side
// guidance and the templates then.
Deno.test("engine canary: exists-gated rows do not propagate cross-account", async () => {
  const canaryApp = jazzSchema.defineApp({
    rooms: jazzSchema.table({ name: jazzSchema.string() }),
    roomMembers: jazzSchema.table({
      groupId: jazzSchema.ref("rooms"),
      user_id: jazzSchema.string(),
    }),
    gated: jazzSchema.table({ roomId: jazzSchema.ref("rooms"), title: jazzSchema.string() }),
    open: jazzSchema.table({ roomId: jazzSchema.ref("rooms"), title: jazzSchema.string() }),
  });
  const canaryPermissions = jazzSchema.definePermissions(canaryApp, (jazzContext) => {
    const { policy, session } = jazzContext as unknown as {
      policy: Record<
        string,
        Record<string, { where(input: unknown): unknown; always(): unknown }> & {
          exists: { where(input: unknown): unknown };
        }
      >;
      session: { user_id: unknown };
    };
    for (const table of ["rooms", "roomMembers", "open"]) {
      policy[table].allowRead.always();
      policy[table].allowInsert.always();
      policy[table].allowUpdate.always();
      policy[table].allowDelete.always();
    }
    policy.gated.allowRead.where((row: Record<string, unknown>) =>
      policy.roomMembers.exists.where({ groupId: row.roomId, user_id: session.user_id })
    );
    policy.gated.allowInsert.always();
    policy.gated.allowUpdate.always();
    policy.gated.allowDelete.always();
  });

  const server = await startLocalJazzServer({ allowLocalFirstAuth: true });
  await deploy({
    appId: server.appId,
    serverUrl: server.url,
    adminSecret: server.adminSecret,
    schema: canaryApp,
    permissions: canaryPermissions,
  });
  const alice = await createDb({
    appId: server.appId,
    serverUrl: server.url,
    secret: secret(11),
    userBranch: "main",
    driver: { type: "memory" },
  });
  const bob = await createDb({
    appId: server.appId,
    serverUrl: server.url,
    secret: secret(12),
    userBranch: "main",
    driver: { type: "memory" },
  });
  try {
    const aliceId = alice.getAuthState().session?.user_id as string;
    const bobId = bob.getAuthState().session?.user_id as string;
    const room = await within(
      alice.insert(canaryApp.rooms, { name: "canary" }).wait({ tier: "global" }),
      "room insert",
    );
    for (const memberId of [aliceId, bobId]) {
      await within(
        alice.insert(canaryApp.roomMembers, { groupId: room.id, user_id: memberId })
          .wait({ tier: "global" }),
        "membership insert",
      );
    }
    const gated = await within(
      alice.insert(canaryApp.gated, { roomId: room.id, title: "gated" })
        .wait({ tier: "global" }),
      "gated insert",
    );
    const open = await within(
      alice.insert(canaryApp.open, { roomId: room.id, title: "open" }).wait({ tier: "global" }),
      "open insert",
    );

    // The always()-gated control row arrives promptly...
    const deadline = Date.now() + 5_000;
    let openSeen = 0;
    while (openSeen === 0 && Date.now() < deadline) {
      openSeen = (await bob.all(canaryApp.open.where({ id: open.id }))).length;
      if (openSeen === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(openSeen === 1, "the always()-gated control row must propagate to bob");

    // ...while the exists-gated row stays absent well past the control's
    // arrival. This is the pinned gap, not the desired behavior.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const gatedSeen = await bob.all(canaryApp.gated.where({ id: gated.id }));
    assert(
      gatedSeen.length === 0,
      "pinned engine behavior changed: exists-gated rows now propagate cross-account — " +
        "revisit the read-side guidance, the collaboration templates, and this canary",
    );
  } finally {
    await Promise.allSettled([
      within(alice.logout(), "Alice cleanup", 3_000),
      within(bob.logout(), "Bob cleanup", 3_000),
    ]);
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
  }
});
