// The group field-key lifecycle end to end against the real pinned server:
// creation mints and self-wraps generation 1, an arriving member receives
// held keys (pinned out-of-band by their lofi2 fingerprint), removal rotates
// to a generation the removed member never receives — and the removed member
// keeps reading old-generation content while new content stays pending for
// them, which is exactly the documented lazy-rekey posture.

import { createDb, schema as jazz } from "jazz-tools";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";
import {
  defineAccessPolicies,
  groupAccess,
  groupMembershipTable,
  groupRoleCapabilities,
  sharedFieldAccess,
  sharedFieldDirectoryTable,
  sharedFieldKeyTable,
} from "./mod.ts";
import {
  bootstrapGroupFieldKey,
  reconcileSharedFieldKeys,
  rotateGroupFieldKey,
  type SharedFieldLifecycleContext,
  wrapHeldKeysForMember,
} from "./shared-field-lifecycle.ts";
import { s } from "../schema/mod.ts";
import { type SharedFieldValue } from "../schema/mod.ts";
import { clearSharedColumnRegistry } from "../schema/shared-registry.ts";
import { clearEncryptedColumnRegistry } from "../schema/encrypted.ts";
import {
  clearSharedFieldIdentity,
  clearSharedFieldKeys,
  installSharedFieldIdentity,
} from "../schema/shared-keyring.ts";
import { sealSharedColumnValuesSync } from "../runtime/shared-field-write.ts";
import {
  clearFingerprintPins,
  deriveSharedFieldIdentity,
  ensureDirectoryEntry,
  startSharedFieldKeyWatcher,
} from "../runtime/shared-field-keys.ts";
import { assert } from "../runtime/test-assert.ts";

const APP_ID = "lifecycle-app";
const SHARED_OPTIONS = {
  group: "workspaces",
  groupIdColumn: "workspaceId",
  keys: "workspaceFieldKeys",
  directory: "keyDirectory",
} as const;

const app = s.defineApp({
  workspaces: jazz.table({ name: jazz.string() }),
  workspaceMembers: groupMembershipTable("workspaces"),
  workspaceFieldKeys: sharedFieldKeyTable("workspaces"),
  keyDirectory: sharedFieldDirectoryTable(),
  docs: jazz.table({
    workspaceId: jazz.ref("workspaces"),
    title: jazz.string(),
    body: s.sharedEncryptedText("lifecycle.docs.body", SHARED_OPTIONS),
  }),
});
// Docs read openly: exists-gated rows do not propagate cross-account at the
// pin (engine canary in shared_directory_sync_test.ts); content protection
// here is the sealing under test.
const permissions = defineAccessPolicies(app, [
  sharedFieldAccess({ directory: app.keyDirectory }),
  groupAccess({
    groups: app.workspaces,
    members: app.workspaceMembers,
    resources: [],
    groupId: "workspaceId",
    fieldKeys: app.workspaceFieldKeys,
  }),
], (context) => {
  context.policy.docs.allowRead.always();
  context.policy.docs.allowInsert.always();
  context.policy.docs.allowUpdate.always();
  context.policy.docs.allowDelete.always();
});

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

async function until(check: () => boolean, label: string, milliseconds = 10_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

Deno.test("the key lifecycle: bootstrap, member delivery, and lazy rekey", async () => {
  clearFingerprintPins(APP_ID);
  clearSharedFieldKeys();
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
  let stopWatcher: (() => void) | null = null;
  try {
    const aliceId = alice.getAuthState().session?.user_id as string;
    const bobId = bob.getAuthState().session?.user_id as string;
    const aliceIdentity = await deriveSharedFieldIdentity("alice-lifecycle-secret");
    const bobIdentity = await deriveSharedFieldIdentity("bob-lifecycle-secret");
    const aliceContext: SharedFieldLifecycleContext = {
      db: alice as never,
      appId: APP_ID,
      userId: aliceId,
      groupTable: "workspaces",
      fieldKeys: app.workspaceFieldKeys,
      directory: app.keyDirectory,
      members: app.workspaceMembers,
    };

    // --- Phase A: Alice creates the group; bootstrap mints generation 1.
    installSharedFieldIdentity(aliceIdentity);
    const workspace = await within(
      alice.insert(app.workspaces, { name: "lifecycle" }).wait({ tier: "global" }),
      "workspace insert",
    );
    await within(
      alice.insert(app.workspaceMembers, {
        groupId: workspace.id,
        user_id: aliceId,
        ...groupRoleCapabilities("admin"),
      }).wait({ tier: "global" }),
      "alice membership",
    );
    await within(bootstrapGroupFieldKey(aliceContext, workspace.id), "bootstrap");

    // The mutation-layer sealer picks up generation 1 transparently.
    const sealedInsert = sealSharedColumnValuesSync("docs", {
      workspaceId: workspace.id,
      title: "first",
      body: "written under generation one",
    });
    assert(
      String(sealedInsert.body).startsWith(`encs1.workspaces.${workspace.id}.1.`),
      "the sealer must use the bootstrapped generation",
    );
    const firstDoc = await within(
      alice.insert(app.docs, sealedInsert as never).wait({ tier: "global" }),
      "first doc insert",
    );

    // --- Phase B: Bob joins; his lofi2 fingerprint pins him out-of-band and
    // Alice's device wraps generation 1 to him.
    await within(
      ensureDirectoryEntry({
        db: bob as never,
        directory: app.keyDirectory,
        userId: bobId,
        identity: bobIdentity,
      }).then(() => undefined),
      "bob publishes",
    );
    await within(
      alice.insert(app.workspaceMembers, {
        groupId: workspace.id,
        user_id: bobId,
        ...groupRoleCapabilities("writer"),
      }).wait({ tier: "global" }),
      "bob membership",
    );
    const delivery = await within(
      wrapHeldKeysForMember(aliceContext, workspace.id, bobId, bobIdentity.fingerprint),
      "wrap held keys for bob",
    );
    assert(
      delivery.wrapped === 1 && delivery.skip === null,
      `bob must receive one wrap (saw ${JSON.stringify(delivery)})`,
    );
    // Repair finds nothing missing afterwards.
    assert(
      (await within(reconcileSharedFieldKeys(aliceContext, workspace.id), "reconcile")) === 0,
      "reconcile after full delivery must be a no-op",
    );

    // --- Phase C: Bob's device (fresh keyring) unwraps through the watcher
    // and reads generation-one content.
    clearSharedFieldKeys();
    installSharedFieldIdentity(bobIdentity);
    stopWatcher = startSharedFieldKeyWatcher({
      db: bob as never,
      appId: APP_ID,
      userId: bobId,
      configs: [{ label: "lifecycle.docs.body", kind: "text", ...SHARED_OPTIONS }],
      findTable: (name) =>
        name === "workspaceFieldKeys"
          ? app.workspaceFieldKeys
          : name === "keyDirectory"
          ? app.keyDirectory
          : null,
      onAlert: (alert) => {
        throw new Error(`unexpected watcher alert: ${alert.code} — ${alert.detail}`);
      },
    });
    let firstBody: SharedFieldValue<string> | undefined;
    await until(() => {
      void bob.all(app.docs.where({ id: firstDoc.id })).then((rows) => {
        firstBody = rows[0]?.body as unknown as SharedFieldValue<string>;
      });
      return firstBody?.state === "ready";
    }, "bob reads generation one");
    assert(
      firstBody?.state === "ready" && firstBody.value === "written under generation one",
      "bob must decrypt generation-one content",
    );
    stopWatcher();
    stopWatcher = null;

    // --- Phase D: Bob is removed; rotation mints generation 2 wrapped only
    // to the remaining member.
    installSharedFieldIdentity(aliceIdentity);
    const bobMembership = await within(
      alice.all(app.workspaceMembers.where({ groupId: workspace.id, user_id: bobId } as never)),
      "find bob's membership",
    );
    await within(
      alice.delete(app.workspaceMembers, (bobMembership[0] as { id: string }).id)
        .wait({ tier: "global" }),
      "remove bob",
    );
    await within(rotateGroupFieldKey(aliceContext, workspace.id, bobId), "rotate");
    const wraps = await within(
      alice.all(app.workspaceFieldKeys.where({ groupId: workspace.id } as never)),
      "list wraps",
    ) as Array<{ recipient_user_id: string; generation: number }>;
    assert(
      !wraps.some((row) => row.recipient_user_id === bobId && row.generation === 2),
      "the removed member must never receive the new generation",
    );
    assert(
      wraps.some((row) => row.recipient_user_id === aliceId && row.generation === 2),
      "the remaining member must receive the new generation",
    );

    const sealedSecond = sealSharedColumnValuesSync("docs", {
      workspaceId: workspace.id,
      title: "second",
      body: "written after the rotation",
    });
    assert(
      String(sealedSecond.body).startsWith(`encs1.workspaces.${workspace.id}.2.`),
      "post-rotation writes must seal under generation two",
    );
    const secondDoc = await within(
      alice.insert(app.docs, sealedSecond as never).wait({ tier: "global" }),
      "second doc insert",
    );

    // --- Phase E: Bob's device holds only generation 1 — old content stays
    // readable, new content stays pending. Lazy rekey, stated honestly.
    clearSharedFieldKeys();
    installSharedFieldIdentity(bobIdentity);
    stopWatcher = startSharedFieldKeyWatcher({
      db: bob as never,
      appId: APP_ID,
      userId: bobId,
      configs: [{ label: "lifecycle.docs.body", kind: "text", ...SHARED_OPTIONS }],
      findTable: (name) =>
        name === "workspaceFieldKeys"
          ? app.workspaceFieldKeys
          : name === "keyDirectory"
          ? app.keyDirectory
          : null,
      onAlert: () => {},
    });
    let oldBody: SharedFieldValue<string> | undefined;
    await until(() => {
      void bob.all(app.docs.where({ id: firstDoc.id })).then((rows) => {
        oldBody = rows[0]?.body as unknown as SharedFieldValue<string>;
      });
      return oldBody?.state === "ready";
    }, "bob re-reads generation one");
    let newBody: SharedFieldValue<string> | undefined;
    await until(() => {
      void bob.all(app.docs.where({ id: secondDoc.id })).then((rows) => {
        newBody = rows[0]?.body as unknown as SharedFieldValue<string>;
      });
      return newBody !== undefined;
    }, "bob sees the second doc row");
    assert(
      newBody?.state === "pending-key" && newBody.generation === 2,
      `generation-two content must stay pending for the removed member ` +
        `(saw ${JSON.stringify(newBody)})`,
    );
  } finally {
    stopWatcher?.();
    clearSharedFieldIdentity();
    clearSharedFieldKeys();
    clearFingerprintPins(APP_ID);
    clearSharedColumnRegistry();
    clearEncryptedColumnRegistry();
    await Promise.allSettled([
      within(alice.logout(), "Alice cleanup", 3_000),
      within(bob.logout(), "Bob cleanup", 3_000),
    ]);
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
  }
});
