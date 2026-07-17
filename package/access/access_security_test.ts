import { schema as s } from "jazz-tools";
import { createPolicyTestApp } from "jazz-tools/testing";
import {
  defineAccessPolicies,
  groupAccess,
  groupMembershipTable,
  groupRoleCapabilities,
  privateAccess,
  sharedAccess,
  sharedGrantTable,
} from "./mod.ts";
import { assert } from "../runtime/test-assert.ts";

const schema = {
  privateDocs: s.table({ title: s.string() }),
  sharedDocs: s.table({ title: s.string() }),
  sharedDocGrants: sharedGrantTable("sharedDocs"),
  workspaces: s.table({ name: s.string() }),
  workspaceMembers: groupMembershipTable("workspaces"),
  groupDocs: s.table({ workspaceId: s.ref("workspaces"), title: s.string() }),
};
const app = s.defineApp(schema);
const permissions = defineAccessPolicies(app, [
  privateAccess({ resource: app.privateDocs }),
  sharedAccess({ resource: app.sharedDocs, grants: app.sharedDocGrants }),
  groupAccess({
    groups: app.workspaces,
    members: app.workspaceMembers,
    resources: app.groupDocs,
    groupId: "workspaceId",
  }),
]);

type ThrowExpectation = {
  toThrow(expected?: unknown): void;
  not: { toThrow(expected?: unknown): void };
};

function expectLike(value: unknown): ThrowExpectation {
  const run = (): unknown => {
    if (typeof value !== "function") throw new Error("expectLike requires a callback");
    try {
      value();
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const matches = (error: unknown, expected: unknown): boolean => {
    if (expected === undefined) return error !== undefined;
    const message = error instanceof Error ? error.message : String(error);
    return typeof expected === "string"
      ? message.includes(expected)
      : error instanceof (expected as typeof Error);
  };
  return {
    toThrow(expected?: unknown) {
      const error = run();
      if (!matches(error, expected)) {
        throw new Error(`expected callback to throw ${String(expected)}`);
      }
    },
    not: {
      toThrow(expected?: unknown) {
        const error = run();
        if (error !== undefined && matches(error, expected)) {
          throw new Error(`expected callback not to throw ${String(expected)}`, { cause: error });
        }
      },
    },
  };
}

const session = (user_id: string) => ({ user_id, claims: {}, authMode: "local-first" as const });

Deno.test("official Jazz harness enforces private and direct-share templates", async () => {
  const testApp = await createPolicyTestApp(app, permissions, expectLike);
  try {
    const owner = testApp.as(session("owner"));
    const reader = testApp.as(session("reader"));
    const editor = testApp.as(session("editor"));
    const stranger = testApp.as(session("stranger"));

    const privateDoc = await owner.insert(app.privateDocs, { title: "private" }).wait({
      tier: "global",
    });
    assert(
      (await owner.all(app.privateDocs.where({ id: privateDoc.id }))).length === 1,
      "owner lost private row",
    );
    assert(
      (await stranger.all(app.privateDocs.where({ id: privateDoc.id }))).length === 0,
      "unrelated user read private row",
    );
    stranger.expectDenied((db) => db.update(app.privateDocs, privateDoc.id, { title: "denied" }));

    const sharedDoc = await owner.insert(app.sharedDocs, { title: "shared" }).wait({
      tier: "global",
    });
    const readGrant = await owner.insert(app.sharedDocGrants, {
      resourceId: sharedDoc.id,
      user_id: "reader",
      can_edit: false,
    }).wait({ tier: "global" });
    await owner.insert(app.sharedDocGrants, {
      resourceId: sharedDoc.id,
      user_id: "editor",
      can_edit: true,
    }).wait({ tier: "global" });

    assert(
      (await reader.all(app.sharedDocs.where({ id: sharedDoc.id }))).length === 1,
      "reader could not read shared row",
    );
    assert(
      (await editor.all(app.sharedDocs.where({ id: sharedDoc.id }))).length === 1,
      "editor could not read shared row",
    );
    assert(
      (await stranger.all(app.sharedDocs.where({ id: sharedDoc.id }))).length === 0,
      "stranger read shared row",
    );
    reader.expectDenied((db) => db.update(app.sharedDocs, sharedDoc.id, { title: "denied" }));
    editor.expectAllowed((db) => db.update(app.sharedDocs, sharedDoc.id, { title: "allowed" }));
    stranger.expectDenied((db) => db.delete(app.sharedDocs, sharedDoc.id));

    await owner.delete(app.sharedDocGrants, readGrant.id).wait({ tier: "global" });
    assert(
      (await reader.all(app.sharedDocs.where({ id: sharedDoc.id }))).length === 0,
      "revoked reader retained access",
    );
  } finally {
    await testApp.shutdown();
  }
});

Deno.test("official Jazz harness enforces fixed group roles and membership lifecycle", async () => {
  const testApp = await createPolicyTestApp(app, permissions, expectLike);
  try {
    const admin = testApp.as(session("admin"));
    const reader = testApp.as(session("reader"));
    const contributor = testApp.as(session("contributor"));
    const writer = testApp.as(session("writer"));
    const stranger = testApp.as(session("stranger"));

    const group = await admin.insert(app.workspaces, {
      name: "workspace",
    }).wait({
      tier: "global",
    });
    assert(
      (await admin.all(app.workspaces.where({ id: group.id }))).length === 1,
      "group creator could not read the created group",
    );
    const initialAdmin = await admin.insert(app.workspaceMembers, {
      groupId: group.id,
      user_id: "admin",
      ...groupRoleCapabilities("admin"),
    }).wait({ tier: "global" });
    assert(initialAdmin.role === "admin", "creator did not bootstrap as first admin");
    const groupId = group.id;
    const memberships = await Promise.all([
      admin.insert(app.workspaceMembers, {
        groupId,
        user_id: "reader",
        ...groupRoleCapabilities("reader"),
      }).wait({
        tier: "global",
      }),
      admin.insert(app.workspaceMembers, {
        groupId,
        user_id: "contributor",
        ...groupRoleCapabilities("contributor"),
      })
        .wait(
          { tier: "global" },
        ),
      admin.insert(app.workspaceMembers, {
        groupId,
        user_id: "writer",
        ...groupRoleCapabilities("writer"),
      }).wait({
        tier: "global",
      }),
    ]);
    assert(
      (await admin.all(app.workspaceMembers.where({ groupId, user_id: "admin", role: "admin" })))
        .length === 1,
      "admin membership was not visible to the admin",
    );
    const adminDoc = await admin.insert(app.groupDocs, { workspaceId: groupId, title: "admin row" })
      .wait({
        tier: "global",
      });

    reader.expectDenied((db) =>
      db.insert(app.groupDocs, { workspaceId: groupId, title: "reader cannot create" })
    );
    contributor.expectAllowed((db) =>
      db.insert(app.groupDocs, { workspaceId: groupId, title: "contributor own" })
    );
    contributor.expectDenied((db) => db.update(app.groupDocs, adminDoc.id, { title: "not own" }));
    writer.expectAllowed((db) => db.update(app.groupDocs, adminDoc.id, { title: "writer" }));
    admin.expectAllowed((db) => db.update(app.groupDocs, adminDoc.id, { title: "admin" }));
    stranger.expectDenied((db) =>
      db.insert(app.groupDocs, { workspaceId: groupId, title: "non-member" })
    );
    assert(
      (await stranger.all(app.groupDocs.where({ workspaceId: groupId }))).length === 0,
      "non-member read group rows",
    );

    admin.expectAllowed((db) =>
      db.update(app.workspaceMembers, memberships[0].id, groupRoleCapabilities("writer"))
    );
    reader.expectDenied((db) =>
      db.update(app.workspaceMembers, memberships[0].id, groupRoleCapabilities("admin"))
    );
    admin.expectAllowed((db) => db.delete(app.workspaceMembers, memberships[1].id));
    writer.expectAllowed((db) => db.delete(app.workspaceMembers, memberships[2].id));
    stranger.expectDenied((db) => db.delete(app.workspaceMembers, memberships[2].id));
  } finally {
    await testApp.shutdown();
  }
});

Deno.test("access templates reject malformed relationship tables with actionable errors", () => {
  const malformed = s.defineApp({
    docs: s.table({ title: s.string() }),
    grants: s.table({ resourceId: s.string(), user_id: s.string(), can_edit: s.boolean() }),
  });
  let message = "";
  try {
    defineAccessPolicies(malformed, [
      sharedAccess({ resource: malformed.docs, grants: malformed.grants }),
    ]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(
    message.includes("grants") && message.includes("resourceId"),
    "configuration error was not actionable",
  );
});
