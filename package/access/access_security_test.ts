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
import { clearEncryptedColumnRegistry, s as lofiSchema } from "../schema/mod.ts";
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
    let ownerRows: Array<s.RowOf<typeof app.sharedDocs>> = [];
    let readerRows: Array<s.RowOf<typeof app.sharedDocs>> = [];
    let editorRows: Array<s.RowOf<typeof app.sharedDocs>> = [];
    const liveSharedDoc = app.sharedDocs.where({ id: sharedDoc.id });
    const stopOwner = owner.subscribeAll(liveSharedDoc, (delta) => ownerRows = delta.all);
    const stopReader = reader.subscribeAll(liveSharedDoc, (delta) => readerRows = delta.all);
    const stopEditor = editor.subscribeAll(liveSharedDoc, (delta) => editorRows = delta.all);

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
    await editor.update(app.sharedDocs, sharedDoc.id, { title: "allowed" }).wait({
      tier: "global",
    });
    assert(
      ownerRows[0]?.title === "allowed" && editorRows[0]?.title === "allowed",
      "authorized live queries did not observe the shared update",
    );
    stranger.expectDenied((db) => db.delete(app.sharedDocs, sharedDoc.id));

    await owner.delete(app.sharedDocGrants, readGrant.id).wait({ tier: "global" });
    assert(readerRows.length === 0, "revocation did not remove the row from the active query");
    assert(
      (await reader.all(app.sharedDocs.where({ id: sharedDoc.id }))).length === 0,
      "revoked reader retained access",
    );
    assert(
      ownerRows.length === 1 && editorRows.length === 1,
      "revocation affected other identities",
    );
    stopOwner();
    stopReader();
    stopEditor();
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
    let adminRows: Array<s.RowOf<typeof app.groupDocs>> = [];
    let readerRows: Array<s.RowOf<typeof app.groupDocs>> = [];
    let writerRows: Array<s.RowOf<typeof app.groupDocs>> = [];
    const liveGroupDocs = app.groupDocs.where({ workspaceId: groupId });
    const stopAdmin = admin.subscribeAll(liveGroupDocs, (delta) => adminRows = delta.all);
    const stopReader = reader.subscribeAll(liveGroupDocs, (delta) => readerRows = delta.all);
    const stopWriter = writer.subscribeAll(liveGroupDocs, (delta) => writerRows = delta.all);
    const liveDoc = await contributor.insert(app.groupDocs, {
      workspaceId: groupId,
      title: "live insert",
    }).wait({ tier: "global" });
    assert(
      [adminRows, readerRows, writerRows].every((rows) =>
        rows.some((row) => row.id === liveDoc.id)
      ),
      "authorized live queries did not observe the group insert",
    );
    await writer.update(app.groupDocs, liveDoc.id, { title: "live update" }).wait({
      tier: "global",
    });
    assert(
      [adminRows, readerRows, writerRows].every((rows) =>
        rows.find((row) => row.id === liveDoc.id)?.title === "live update"
      ),
      "authorized live queries did not observe the group update",
    );
    await admin.delete(app.groupDocs, liveDoc.id).wait({ tier: "global" });
    assert(
      [adminRows, readerRows, writerRows].every((rows) =>
        rows.every((row) => row.id !== liveDoc.id)
      ),
      "authorized live queries did not observe the group delete",
    );

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
    stopAdmin();
    stopReader();
    stopWriter();
  } finally {
    await testApp.shutdown();
  }
});

Deno.test("group-creator authority is permanent, exclusive, and survives demotion", async () => {
  const testApp = await createPolicyTestApp(app, permissions, expectLike);
  try {
    const creator = testApp.as(session("creator"));
    const successor = testApp.as(session("successor"));
    const stranger = testApp.as(session("stranger"));

    const group = await creator.insert(app.workspaces, { name: "handover" }).wait({
      tier: "global",
    });
    // Creator authority never extends to anyone else.
    stranger.expectDenied((db) => db.update(app.workspaces, group.id, { name: "hijacked" }));
    stranger.expectDenied((db) =>
      db.insert(app.workspaceMembers, {
        groupId: group.id,
        user_id: "stranger",
        ...groupRoleCapabilities("admin"),
      })
    );
    stranger.expectDenied((db) => db.delete(app.workspaces, group.id));

    const creatorMembership = await creator.insert(app.workspaceMembers, {
      groupId: group.id,
      user_id: "creator",
      ...groupRoleCapabilities("admin"),
    }).wait({ tier: "global" });
    await creator.insert(app.workspaceMembers, {
      groupId: group.id,
      user_id: "successor",
      ...groupRoleCapabilities("admin"),
    }).wait({ tier: "global" });

    // The documented trust property of the template on the pinned Jazz
    // alpha.53 engine: demoting or removing the creator does NOT end their
    // authority — they retain group update and, through it, membership
    // management, so they can always restore their own admin membership.
    // The engine cannot express "creator authority only while no admin
    // exists" (see the negation canary below); when that becomes possible,
    // this contract is expected to change to a bootstrap-only window.
    successor.expectAllowed((db) =>
      db.update(app.workspaceMembers, creatorMembership.id, groupRoleCapabilities("reader"))
    );
    creator.expectAllowed((db) =>
      db.update(app.workspaceMembers, creatorMembership.id, groupRoleCapabilities("admin"))
    );
    successor.expectAllowed((db) => db.delete(app.workspaceMembers, creatorMembership.id));
    creator.expectAllowed((db) =>
      db.insert(app.workspaceMembers, {
        groupId: group.id,
        user_id: "creator",
        ...groupRoleCapabilities("admin"),
      })
    );
  } finally {
    await testApp.shutdown();
  }
});

Deno.test("engine canary: pinned alpha.53 silently drops Not around existence conditions", async () => {
  // Guard rule that SHOULD deny deletion while an admin membership exists:
  // Not(ExistsRel(members WHERE groupId = <this group> AND can_manage)).
  // The pinned engine ignores the negation, so the delete is ALLOWED below.
  // WHEN THIS TEST FAILS after a jazz-tools upgrade: negation started
  // working — replace permanent group-creator authority with the
  // bootstrap-only window design in
  // docs/decisions/group-creator-authority-alpha53.md and update the
  // permanent-authority contract test above.
  const canaryPermissions = s.definePermissions(app, (rawContext) => {
    const { policy } = rawContext as unknown as {
      policy: Record<
        string,
        {
          allowRead: { always(): unknown };
          allowInsert: { always(): unknown };
          allowDelete: { where(input: unknown): unknown };
        }
      >;
    };
    policy.workspaces.allowRead.always();
    policy.workspaces.allowInsert.always();
    policy.workspaceMembers.allowRead.always();
    policy.workspaceMembers.allowInsert.always();
    policy.workspaces.allowDelete.where({
      type: "Not",
      expr: {
        type: "ExistsRel",
        rel: {
          Filter: {
            input: { TableScan: { table: "workspaceMembers" } },
            predicate: {
              And: [
                {
                  Cmp: {
                    left: { column: "groupId" },
                    op: "Eq",
                    right: { OuterColumn: { column: "id" } },
                  },
                },
                {
                  Cmp: {
                    left: { column: "can_manage" },
                    op: "Eq",
                    right: { Literal: true },
                  },
                },
              ],
            },
          },
        },
      },
    });
  });
  const testApp = await createPolicyTestApp(app, canaryPermissions, expectLike);
  try {
    const creator = testApp.as(session("creator"));
    const group = await creator.insert(app.workspaces, { name: "canary" }).wait({
      tier: "global",
    });
    await creator.insert(app.workspaceMembers, {
      groupId: group.id,
      user_id: "creator",
      ...groupRoleCapabilities("admin"),
    }).wait({ tier: "global" });
    // A working Not would DENY this delete (an admin membership exists).
    creator.expectAllowed((db) => db.delete(app.workspaces, group.id));
  } finally {
    await testApp.shutdown();
  }
});

Deno.test("a group without its first admin remains deletable by its creator only", async () => {
  const testApp = await createPolicyTestApp(app, permissions, expectLike);
  try {
    const creator = testApp.as(session("creator"));
    const stranger = testApp.as(session("stranger"));
    // A group whose first-admin insert failed: the row exists, no membership.
    const orphan = await creator.insert(app.workspaces, { name: "orphan" }).wait({
      tier: "global",
    });
    stranger.expectDenied((db) => db.delete(app.workspaces, orphan.id));
    await creator.delete(app.workspaces, orphan.id).wait({ tier: "global" });
    assert(
      (await creator.all(app.workspaces.where({ id: orphan.id }))).length === 0,
      "the creator's rollback delete did not remove the orphaned group",
    );
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

Deno.test("policies referencing encrypted columns fail configuration", () => {
  clearEncryptedColumnRegistry();
  try {
    // Template-consumed column: user_id sealed in a grant table. requireColumn
    // must refuse before the type check ever compares the built schema, where
    // an encrypted column is indistinguishable TEXT.
    const sealedGrantApp = lofiSchema.defineApp({
      sealedDocs: lofiSchema.table({ title: lofiSchema.string() }),
      sealedDocGrants: lofiSchema.table({
        resourceId: lofiSchema.ref("sealedDocs"),
        user_id: lofiSchema.encryptedText("sealedDocGrants.user_id"),
        can_edit: lofiSchema.boolean(),
      }),
    });
    let templateMessage = "";
    try {
      defineAccessPolicies(sealedGrantApp, [
        sharedAccess({
          resource: sealedGrantApp.sealedDocs,
          grants: sealedGrantApp.sealedDocGrants,
        }),
      ]);
    } catch (error) {
      templateMessage = error instanceof Error ? error.message : String(error);
    }
    assert(
      templateMessage.includes("encrypted") && templateMessage.includes("user_id"),
      `template with encrypted user_id compiled: ${templateMessage || "no error"}`,
    );

    // Raw-extension rules: an object condition keyed by an encrypted column
    // must refuse — such a policy would compile but silently never match.
    const rawApp = lofiSchema.defineApp({
      vaultDocs: lofiSchema.table({
        title: lofiSchema.string(),
        secret: lofiSchema.encryptedText("vaultDocs.secret"),
      }),
    });
    let objectMessage = "";
    try {
      defineAccessPolicies(rawApp, [privateAccess({ resource: rawApp.vaultDocs })], (context) => {
        context.policy.vaultDocs.allowRead.where({ secret: "visible" });
      });
    } catch (error) {
      objectMessage = error instanceof Error ? error.message : String(error);
    }
    assert(
      objectMessage.includes("encrypted") && objectMessage.includes("secret"),
      `object condition on encrypted column compiled: ${objectMessage || "no error"}`,
    );

    // A function condition whose returned literal is keyed by an encrypted
    // column is checked the same way.
    let functionMessage = "";
    try {
      defineAccessPolicies(rawApp, [privateAccess({ resource: rawApp.vaultDocs })], (context) => {
        context.policy.vaultDocs.allowUpdate.where(() => ({ secret: "visible" }));
      });
    } catch (error) {
      functionMessage = error instanceof Error ? error.message : String(error);
    }
    assert(
      functionMessage.includes("encrypted") && functionMessage.includes("secret"),
      `function condition on encrypted column compiled: ${functionMessage || "no error"}`,
    );
  } finally {
    clearEncryptedColumnRegistry();
  }
});
