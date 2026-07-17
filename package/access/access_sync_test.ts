import { createDb, schema as s } from "jazz-tools";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";
import {
  defineAccessPolicies,
  groupAccess,
  groupMembershipTable,
  groupRoleCapabilities,
  sharedAccess,
  sharedGrantTable,
} from "./mod.ts";
import { assert } from "../runtime/test-assert.ts";

const app = s.defineApp({
  sharedDocs: s.table({ title: s.string() }),
  sharedDocGrants: sharedGrantTable("sharedDocs"),
  workspaces: s.table({ name: s.string() }),
  workspaceMembers: groupMembershipTable("workspaces"),
  workspaceDocs: s.table({ workspaceId: s.ref("workspaces"), title: s.string() }),
});
const permissions = defineAccessPolicies(app, [
  sharedAccess({ resource: app.sharedDocs, grants: app.sharedDocGrants }),
  groupAccess({
    groups: app.workspaces,
    members: app.workspaceMembers,
    resources: app.workspaceDocs,
    groupId: "workspaceId",
  }),
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

Deno.test("real sync persists offline grant, revoke, and membership changes after reconnect", async () => {
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
    const aliceId = alice.getAuthState().session?.user_id;
    const bobId = bob.getAuthState().session?.user_id;
    assert(Boolean(aliceId && bobId && aliceId !== bobId), "test principals were not isolated");

    const shared = await alice.insert(app.sharedDocs, { title: "shared" }).wait({ tier: "global" });
    await alice.disconnect();
    const grant = alice.insert(app.sharedDocGrants, {
      resourceId: shared.id,
      user_id: bobId!,
      can_edit: false,
    });
    assert(grant.value.user_id === bobId, "offline grant did not apply locally");
    await alice.reconnect();
    await within(grant.wait({ tier: "global" }), "grant global durability");
    assert(
      (await alice.all(app.sharedDocGrants.where({ id: grant.value.id }), { tier: "global" }))
        .length === 1,
      "reconnected grant did not persist globally",
    );

    await alice.disconnect();
    const revoke = alice.delete(app.sharedDocGrants, grant.value.id);
    await alice.reconnect();
    await within(revoke.wait({ tier: "global" }), "revoke global durability");
    assert(
      (await alice.all(app.sharedDocGrants.where({ id: grant.value.id }), { tier: "global" }))
        .length === 0,
      "reconnected revoke did not persist globally",
    );

    const workspace = await alice.insert(app.workspaces, {
      name: "workspace",
    }).wait({ tier: "global" });
    const initialAdmin = await alice.insert(app.workspaceMembers, {
      groupId: workspace.id,
      user_id: aliceId!,
      ...groupRoleCapabilities("admin"),
    }).wait({ tier: "global" });
    assert(
      initialAdmin.role === "admin",
      "group bootstrap did not create the first admin membership",
    );
    await alice.disconnect();
    const membership = alice.insert(app.workspaceMembers, {
      groupId: workspace.id,
      user_id: bobId!,
      ...groupRoleCapabilities("reader"),
    });
    assert(membership.value.user_id === bobId, "offline membership did not apply locally");
    await alice.reconnect();
    await within(membership.wait({ tier: "global" }), "membership global durability");
    assert(
      (await alice.all(app.workspaceMembers.where({ id: membership.value.id }), { tier: "global" }))
        .length === 1,
      "reconnected membership did not persist globally",
    );
  } finally {
    await Promise.allSettled([
      within(alice.logout(), "Alice cleanup", 3_000),
      within(bob.logout(), "Bob cleanup", 3_000),
    ]);
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
  }
});
