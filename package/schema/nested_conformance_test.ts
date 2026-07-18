// Nested-namespace conformance: nested handles, per-namespace permissions,
// and rewritten refs exercised against the real pinned Jazz engine, plus the
// migration story — moving a table between namespaces is an ordinary
// renameTableFrom migration over the flattened schema. The naming layer
// itself is unit-tested in ./nested_test.ts.
import { createDb } from "jazz-tools";
import { createPolicyTestApp, deploy, startLocalJazzServer } from "jazz-tools/testing";
import { assert } from "../runtime/test-assert.ts";
import { nestedAppDeployTarget, s } from "./mod.ts";

const root = s.defineNestedApp({
  taskapp: {
    projects: s.table({ name: s.string() }),
    tasks: s.table({ projectId: s.ref("projects"), text: s.string() }),
  },
  notesapp: {
    notes: s.table({ title: s.string(), secret: s.boolean() }),
  },
});

const taskPermissions = s.defineNestedPermissions(root.taskapp, ({ policy }) => {
  policy.projects.allowInsert.always();
  policy.projects.allowRead.always();
  policy.tasks.allowInsert.always();
  policy.tasks.allowRead.always();
  policy.tasks.allowUpdate.always();
  policy.tasks.allowDelete.always();
});
const notePermissions = s.defineNestedPermissions(root.notesapp, ({ policy, session }) => {
  policy.notes.allowInsert.always();
  policy.notes.allowRead.where({ secret: false });
  policy.notes.allowRead.where({ $createdBy: session.user_id });
});
const permissions = s.mergeNestedPermissions(taskPermissions, notePermissions);

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
      return error ?? new Error("threw undefined");
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
        if (error !== undefined && (expected === undefined || matches(error, expected))) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`expected callback not to throw, received: ${message}`);
        }
      },
    },
  };
}

const session = (user_id: string) => ({ user_id, claims: {}, authMode: "local-first" as const });

Deno.test("nested handles round-trip through the real engine with per-namespace policies", async () => {
  const testApp = await createPolicyTestApp(
    nestedAppDeployTarget(root) as never,
    permissions,
    expectLike,
  );
  try {
    const db = testApp.as(session("author"));

    // Rewritten refs are real foreign keys: the where on the fk filters.
    const project = await db.insert(root.taskapp.projects, { name: "launch" })
      .wait({ tier: "global" });
    const decoy = await db.insert(root.taskapp.projects, { name: "decoy" })
      .wait({ tier: "global" });
    await db.insert(root.taskapp.tasks, { projectId: project.id, text: "ship it" })
      .wait({ tier: "global" });
    await db.insert(root.taskapp.tasks, { projectId: decoy.id, text: "other" })
      .wait({ tier: "global" });
    const tasks = await db.all(root.taskapp.tasks.where({ projectId: project.id }));
    assert(
      tasks.length === 1 && tasks[0].text === "ship it",
      `nested ref where returned ${tasks.length} rows`,
    );

    // Sibling namespaces share the one store but keep their own policies.
    await db.insert(root.notesapp.notes, { title: "public", secret: false })
      .wait({ tier: "global" });
    await db.insert(root.notesapp.notes, { title: "private", secret: true })
      .wait({ tier: "global" });
    const viewer = testApp.as(session("viewer"));
    const viewerNotes = await viewer.all(root.notesapp.notes.where({}));
    assert(
      viewerNotes.length === 1 && viewerNotes[0].title === "public",
      `notesapp policy exposed ${viewerNotes.length} rows to a non-author`,
    );
    const viewerTasks = await viewer.all(root.taskapp.tasks.where({}));
    assert(
      viewerTasks.length === 2,
      `taskapp allow-all read exposed ${viewerTasks.length} rows, expected 2`,
    );
  } finally {
    await testApp.shutdown();
  }
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

Deno.test("moving a table between namespaces is an ordinary renameTableFrom migration", async () => {
  const archiveTable = { archive: s.table({ label: s.string() }) };
  const v1Def = { taskapp: archiveTable, notesapp: { notes: s.table({ title: s.string() }) } };
  const v2Def = {
    taskapp: { placeholder: s.table({ name: s.string() }) },
    notesapp: { notes: s.table({ title: s.string() }), ...archiveTable },
  };
  const rootV1 = s.defineNestedApp(v1Def);
  const rootV2 = s.defineNestedApp(v2Def);
  // Migrations are authored over the flattened global schema — one schema,
  // one migration lineage; the namespace move is just a table rename.
  const migration = s.defineMigration({
    from: s.defineSchema(s.flattenNestedSchema(v1Def) as never),
    to: s.defineSchema(s.flattenNestedSchema(v2Def) as never),
    renameTables: { notesapp__archive: s.renameTableFrom("taskapp__archive") },
    migrate: {},
  } as never);
  const allowAll = (namespace: never, tables: string[]) =>
    s.defineNestedPermissions(namespace, ({ policy }) => {
      const rules = policy as unknown as Record<
        string,
        Record<"allowInsert" | "allowRead" | "allowUpdate" | "allowDelete", { always(): void }>
      >;
      for (const table of tables) {
        rules[table].allowInsert.always();
        rules[table].allowRead.always();
        rules[table].allowUpdate.always();
        rules[table].allowDelete.always();
      }
    });
  const permissionsV1 = s.mergeNestedPermissions(
    allowAll(rootV1.taskapp as never, ["archive"]),
    allowAll(rootV1.notesapp as never, ["notes"]),
  );
  const permissionsV2 = s.mergeNestedPermissions(
    allowAll(rootV2.taskapp as never, ["placeholder"]),
    allowAll(rootV2.notesapp as never, ["notes", "archive"]),
  );

  const server = await startLocalJazzServer({ allowLocalFirstAuth: true });
  const clients: Awaited<ReturnType<typeof createDb>>[] = [];
  const client = async (fill: number) => {
    const db = await createDb({
      appId: server.appId,
      serverUrl: server.url,
      secret: secret(fill),
      userBranch: "main",
      driver: { type: "memory" },
    });
    clients.push(db);
    return db;
  };
  try {
    await deploy({
      appId: server.appId,
      serverUrl: server.url,
      adminSecret: server.adminSecret,
      schema: nestedAppDeployTarget(rootV1) as never,
      permissions: permissionsV1,
    });
    const alice = await client(1);
    const archived = await within(
      alice.insert(rootV1.taskapp.archive, { label: "moved" }).wait({ tier: "global" }),
      "v1 archive insert",
    );

    await within(
      deploy({
        appId: server.appId,
        serverUrl: server.url,
        adminSecret: server.adminSecret,
        schema: nestedAppDeployTarget(rootV2) as never,
        permissions: permissionsV2,
        migration,
      }),
      "v2 deploy with the namespace-move migration",
    );

    const bob = await client(2);
    const rows = await within(
      bob.all(rootV2.notesapp.archive.where({ id: archived.id }), { tier: "global" }),
      "v2 archive read",
    );
    assert(
      rows.length === 1 && rows[0].label === "moved",
      `row did not follow its table across namespaces: ${JSON.stringify(rows)}`,
    );
  } finally {
    await Promise.allSettled(
      clients.map((db, index) => within(db.logout(), `client ${index} cleanup`, 3_000)),
    );
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
  }
});
