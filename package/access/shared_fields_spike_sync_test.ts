// Stage 0 spike for shared-field encryption (#154): pins the three engine
// behaviors the design depends on, against the real pinned server.
//
// (a) Policy expressibility — a key-directory table can be world-readable
//     (`allowRead.always()`) while its writes stay self-scoped, and a
//     wrapped-key table can combine recipient scope with membership under
//     `anyOf`.
// (b) Transform re-materialization — a column transform runs at every
//     materialization, so a read that fails before a key is installed
//     succeeds after installation with no schema redefinition.
// (c) Wrapped-key data flow — a sender-written wrapped-key row syncs to its
//     recipient and stays invisible to a third account.
//
// The "wrap" here is a stand-in opaque string, not the authcrypt sealed box
// (that is Stage 1 client crypto with no engine dependency); the spike's
// subject is the engine.
import { createDb, schema as s } from "jazz-tools";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";
import {
  clearEncryptedColumnKey,
  encryptedText,
  setEncryptedColumnKey,
} from "../schema/encrypted.ts";
import { EncryptedColumnError } from "../schema/encrypted.ts";
import { assert } from "../runtime/test-assert.ts";

const app = s.defineApp({
  workspaces: s.table({ name: s.string() }),
  workspaceMembers: s.table({
    groupId: s.ref("workspaces"),
    user_id: s.string(),
  }),
  keyDirectory: s.table({
    user_id: s.string(),
    algo: s.string(),
    public_key: s.string(),
    fingerprint: s.string(),
  }),
  fieldKeys: s.table({
    groupId: s.ref("workspaces"),
    recipient_user_id: s.string(),
    sender_user_id: s.string(),
    generation: s.int(),
    wrapped_key: s.string(),
  }),
  vault: s.table({
    label: s.string(),
    secret: encryptedText("spike.vault.secret"),
  }),
});

const permissions = s.definePermissions(app, (jazzContext) => {
  const { policy, session, anyOf, allOf } = jazzContext as unknown as {
    policy: Record<
      string,
      Record<string, { where(input: unknown): unknown; always(): unknown }> & {
        exists: { where(input: unknown): unknown };
      }
    >;
    session: { user_id: unknown };
    anyOf(conditions: readonly unknown[]): unknown;
    allOf(conditions: readonly unknown[]): unknown;
  };

  policy.workspaces.allowRead.always();
  policy.workspaces.allowInsert.always();
  policy.workspaces.allowUpdate.always();
  policy.workspaces.allowDelete.always();

  policy.workspaceMembers.allowRead.always();
  policy.workspaceMembers.allowInsert.always();
  policy.workspaceMembers.allowUpdate.always();
  policy.workspaceMembers.allowDelete.always();

  // (a) The directory: world-readable, self-scoped writes.
  policy.keyDirectory.allowRead.always();
  policy.keyDirectory.allowInsert.where({ user_id: session.user_id });
  policy.keyDirectory.allowUpdate.where({ user_id: session.user_id });
  policy.keyDirectory.allowDelete.where({ user_id: session.user_id });

  const isMember = (groupId: unknown) =>
    policy.workspaceMembers.exists.where({ groupId, user_id: session.user_id });

  // (a) Wrapped keys: readable by the recipient or any member; writable by a
  // member who signs as themselves.
  policy.fieldKeys.allowRead.where((row: Record<string, unknown>) =>
    anyOf([{ recipient_user_id: session.user_id }, isMember(row.groupId)])
  );
  policy.fieldKeys.allowInsert.where((row: Record<string, unknown>) =>
    allOf([{ sender_user_id: session.user_id }, isMember(row.groupId)])
  );
  policy.fieldKeys.allowUpdate.where({ sender_user_id: session.user_id });
  policy.fieldKeys.allowDelete.where({ sender_user_id: session.user_id });

  policy.vault.allowRead.where({ $createdBy: session.user_id });
  policy.vault.allowInsert.always();
  policy.vault.allowUpdate.where({ $createdBy: session.user_id });
  policy.vault.allowDelete.where({ $createdBy: session.user_id });
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

Deno.test("stage-0 spike: directory policy, wrapped-key flow, and late-key reads", async () => {
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
  const carol = await createDb({
    appId: server.appId,
    serverUrl: server.url,
    secret: secret(3),
    userBranch: "main",
    driver: { type: "memory" },
  });
  try {
    const aliceId = alice.getAuthState().session?.user_id as string;
    const bobId = bob.getAuthState().session?.user_id as string;
    const carolId = carol.getAuthState().session?.user_id as string;
    assert(
      Boolean(aliceId && bobId && carolId) && new Set([aliceId, bobId, carolId]).size === 3,
      "test principals were not isolated",
    );

    // (a) Self-publish directory rows; a foreign read sees them (always()).
    await within(
      alice.insert(app.keyDirectory, {
        user_id: aliceId,
        algo: "x25519-v1",
        public_key: "spike-alice-pub",
        fingerprint: "spike-alice-fp",
      }).wait({ tier: "global" }),
      "alice directory publish",
    );
    const aliceRowSeenByBob = await within(
      bob.all(app.keyDirectory.where({ user_id: aliceId })),
      "bob reads alice's directory row",
    );
    assert(
      aliceRowSeenByBob.length === 1 && aliceRowSeenByBob[0].public_key === "spike-alice-pub",
      `allowRead.always() did not expose the directory row (saw ${aliceRowSeenByBob.length})`,
    );

    // (a) Foreign-identity writes to the directory must be denied.
    let impersonationDenied = false;
    try {
      await within(
        bob.insert(app.keyDirectory, {
          user_id: aliceId,
          algo: "x25519-v1",
          public_key: "evil-pub",
          fingerprint: "evil-fp",
        }).wait({ tier: "global" }),
        "bob impersonates alice in the directory",
      );
    } catch {
      impersonationDenied = true;
    }
    assert(impersonationDenied, "self-scoped directory insert did not deny a foreign user_id");

    // (c) Wrapped-key flow: Alice creates the group, enrolls both members,
    // and wraps a key to Bob. Bob sees it; Carol does not.
    const workspace = await within(
      alice.insert(app.workspaces, { name: "spike" }).wait({ tier: "global" }),
      "workspace insert",
    );
    await within(
      alice.insert(app.workspaceMembers, { groupId: workspace.id, user_id: aliceId })
        .wait({ tier: "global" }),
      "alice membership",
    );
    await within(
      alice.insert(app.workspaceMembers, { groupId: workspace.id, user_id: bobId })
        .wait({ tier: "global" }),
      "bob membership",
    );
    await within(
      alice.insert(app.fieldKeys, {
        groupId: workspace.id,
        recipient_user_id: bobId,
        sender_user_id: aliceId,
        generation: 1,
        wrapped_key: "wrap1.spike-opaque-wrapped-key-for-bob",
      }).wait({ tier: "global" }),
      "alice wraps for bob",
    );
    const bobWraps = await within(
      bob.all(app.fieldKeys.where({ recipient_user_id: bobId })),
      "bob reads his wrapped key",
    );
    assert(
      bobWraps.length === 1 &&
        bobWraps[0].wrapped_key === "wrap1.spike-opaque-wrapped-key-for-bob" &&
        bobWraps[0].generation === 1,
      `recipient-scoped wrapped-key read failed (saw ${bobWraps.length})`,
    );
    const carolWraps = await within(
      carol.all(app.fieldKeys.where({ groupId: workspace.id } as never)),
      "carol probes wrapped keys",
    );
    assert(
      carolWraps.length === 0,
      `a non-member saw ${carolWraps.length} wrapped-key rows — the anyOf scope leaks`,
    );

    // A forged sender identity must be denied even for a member.
    let forgedSenderDenied = false;
    try {
      await within(
        bob.insert(app.fieldKeys, {
          groupId: workspace.id,
          recipient_user_id: bobId,
          sender_user_id: aliceId,
          generation: 2,
          wrapped_key: "wrap1.forged-sender",
        }).wait({ tier: "global" }),
        "bob forges alice as sender",
      );
    } catch {
      forgedSenderDenied = true;
    }
    assert(forgedSenderDenied, "allOf sender scope did not deny a forged sender_id");

    // (b) Late-key reads: with no key installed the sealed read fails closed;
    // installing the key and re-materializing the same query succeeds without
    // any schema or subscription redefinition. This is the pending→ready
    // mechanic shared fields rely on.
    setEncryptedColumnKey(new Uint8Array(32).map((_, index) => index + 1));
    const sealed = await within(
      alice.insert(app.vault, { label: "spike", secret: "the sealed value" })
        .wait({ tier: "global" }),
      "sealed insert",
    );
    clearEncryptedColumnKey();
    let failedClosed = false;
    try {
      await within(alice.all(app.vault.where({ id: sealed.id })), "read without key");
    } catch (error) {
      failedClosed = error instanceof EncryptedColumnError && error.code === "key-missing";
    }
    assert(failedClosed, "a sealed read without an installed key did not fail closed");
    setEncryptedColumnKey(new Uint8Array(32).map((_, index) => index + 1));
    const reread = await within(
      alice.all(app.vault.where({ id: sealed.id })),
      "read after key install",
    );
    assert(
      reread.length === 1 && reread[0].secret === "the sealed value",
      "re-materialization after key install did not decrypt",
    );
  } finally {
    clearEncryptedColumnKey();
    await Promise.allSettled([
      within(alice.logout(), "Alice cleanup", 3_000),
      within(bob.logout(), "Bob cleanup", 3_000),
      within(carol.logout(), "Carol cleanup", 3_000),
    ]);
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
  }
});
