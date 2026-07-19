// The shared-field read side, end to end against the real pinned server:
// Alice seals a value under a group field key and wraps the key to Bob; the
// real watcher on Bob's client verifies the sender through the pin store,
// unwraps, installs — and Bob's read of the same row transitions from
// pending-key to ready with no redefinition.

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
import { s } from "../schema/mod.ts";
import {
  clearSharedColumnRegistry,
  clearSharedFieldKeys,
  sharedFieldReady,
  type SharedFieldValue,
} from "../schema/mod.ts";
import { generateFieldKey, sealSharedValue, wrapFieldKey } from "../schema/shared-crypto.ts";
import { clearEncryptedColumnRegistry } from "../schema/encrypted.ts";
import { clearSharedFieldIdentity, installSharedFieldIdentity } from "../schema/shared-keyring.ts";
import {
  clearFingerprintPins,
  deriveSharedFieldIdentity,
  ensureDirectoryEntry,
  startSharedFieldKeyWatcher,
} from "../runtime/shared-field-keys.ts";
import { assert } from "../runtime/test-assert.ts";

const SHARED_OPTIONS = {
  group: "workspaces",
  groupIdColumn: "workspaceId",
  keys: "workspaceFieldKeys",
  directory: "keyDirectory",
} as const;

const app = jazz.defineApp({
  workspaces: jazz.table({ name: jazz.string() }),
  workspaceMembers: groupMembershipTable("workspaces"),
  workspaceFieldKeys: sharedFieldKeyTable("workspaces"),
  keyDirectory: sharedFieldDirectoryTable(),
  docs: jazz.table({
    workspaceId: jazz.ref("workspaces"),
    title: jazz.string(),
    body: s.sharedEncryptedText("readsync.docs.body", SHARED_OPTIONS),
  }),
});
// The docs table is deliberately NOT a groupAccess resource: on the pinned
// alpha.53 server, rows gated by an exists-based read condition never
// propagate to other accounts over sync (pinned by the engine canary in
// shared_directory_sync_test.ts), so the demo table reads openly and the
// CONTENT protection under test here is the encryption — which is the
// threat-model posture anyway: policies bound identities, sealing bounds
// the server.
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

Deno.test("a wrapped key turns Bob's pending read into plaintext", async () => {
  clearFingerprintPins("read-sync-app");
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
    const aliceIdentity = await deriveSharedFieldIdentity("alice-shared-secret");
    const bobIdentity = await deriveSharedFieldIdentity("bob-shared-secret");

    // Both accounts publish their keys.
    await within(
      ensureDirectoryEntry({
        db: alice as never,
        directory: app.keyDirectory,
        userId: aliceId,
        identity: aliceIdentity,
      }).then(() => undefined),
      "alice publishes",
    );
    await within(
      ensureDirectoryEntry({
        db: bob as never,
        directory: app.keyDirectory,
        userId: bobId,
        identity: bobIdentity,
      }).then(() => undefined),
      "bob publishes",
    );

    // Alice creates the workspace with both members and seals a doc under a
    // fresh field key.
    const workspace = await within(
      alice.insert(app.workspaces, { name: "shared" }).wait({ tier: "global" }),
      "workspace insert",
    );
    for (const memberId of [aliceId, bobId]) {
      await within(
        alice.insert(app.workspaceMembers, {
          groupId: workspace.id,
          user_id: memberId,
          ...groupRoleCapabilities(memberId === aliceId ? "admin" : "writer"),
        }).wait({ tier: "global" }),
        `membership for ${memberId}`,
      );
    }
    const fieldKey = generateFieldKey();
    const sealed = sealSharedValue({
      plaintext: "sealed for the whole workspace",
      fieldKey,
      label: "readsync.docs.body",
      scope: { groupTable: "workspaces", groupId: workspace.id, generation: 1 },
    });
    const doc = await within(
      alice.insert(app.docs, {
        workspaceId: workspace.id,
        title: "plain title",
        body: sealed as never,
      }).wait({ tier: "global" }),
      "sealed doc insert",
    );

    // Bob sees the row but the body is pending — no key has arrived. The row
    // itself propagates asynchronously, so poll for its arrival first.
    let pendingBody: SharedFieldValue<string> | undefined;
    await until(() => {
      void bob.all(app.docs.where({ id: doc.id })).then((rows) => {
        pendingBody = rows[0]?.body as unknown as SharedFieldValue<string>;
      });
      return pendingBody !== undefined;
    }, "bob's doc row arrives");
    assert(
      pendingBody?.state === "pending-key",
      `bob's keyless read must be pending (saw ${JSON.stringify(pendingBody)})`,
    );

    // Bob's watcher comes up, then Alice wraps the key to him.
    installSharedFieldIdentity(bobIdentity);
    stopWatcher = startSharedFieldKeyWatcher({
      db: bob as never,
      appId: "read-sync-app",
      userId: bobId,
      configs: [{ label: "readsync.docs.body", kind: "text", ...SHARED_OPTIONS }],
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
    await within(
      alice.insert(app.workspaceFieldKeys, {
        groupId: workspace.id,
        recipient_user_id: bobId,
        sender_user_id: aliceId,
        generation: 1,
        wrapped_key: wrapFieldKey({
          fieldKey,
          senderSecret: aliceIdentity.secret,
          recipientPublic: bobIdentity.publicKey,
          context: {
            groupTable: "workspaces",
            groupId: workspace.id,
            generation: 1,
            recipientUserId: bobId,
            senderUserId: aliceId,
          },
        }),
        recipient_fingerprint: bobIdentity.fingerprint,
        sender_fingerprint: aliceIdentity.fingerprint,
      }).wait({ tier: "global" }),
      "alice wraps for bob",
    );

    // The wrap syncs, the watcher installs, and the same query decrypts.
    let readyBody: SharedFieldValue<string> | undefined;
    await until(() => {
      void bob.all(app.docs.where({ id: doc.id })).then((rows) => {
        readyBody = rows[0]?.body as unknown as SharedFieldValue<string>;
      });
      return readyBody !== undefined && readyBody.state === "ready";
    }, "bob's read settles to ready");
    assert(
      readyBody !== undefined && sharedFieldReady(readyBody) &&
        readyBody.value === "sealed for the whole workspace",
      "bob must decrypt the shared body after the wrap arrives",
    );
  } finally {
    stopWatcher?.();
    clearSharedFieldIdentity();
    clearSharedFieldKeys();
    clearFingerprintPins("read-sync-app");
    clearSharedColumnRegistry();
    clearEncryptedColumnRegistry();
    await Promise.allSettled([
      within(alice.logout(), "Alice cleanup", 3_000),
      within(bob.logout(), "Bob cleanup", 3_000),
    ]);
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
  }
});
