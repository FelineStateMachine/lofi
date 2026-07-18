// Migration conformance: the facade's schema-evolution members exercised
// against a real JazzServer — defineSchema, defineMigration, renameTableFrom,
// and the column ops add/drop/renameFrom. A v1 deployment takes writes, then
// v2 deploys with the migration lens and both schema versions read the same
// rows. Runs in its own process before the conformance suite (see the
// test:conformance task).
import { createDb } from "jazz-tools";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";
import { assert } from "../runtime/test-assert.ts";
import { s } from "./mod.ts";

const v1 = s.defineSchema({
  todos: s.table({ title: s.string(), done: s.boolean(), detail: s.string() }),
  projects: s.table({ name: s.string() }),
});
const v2 = s.defineSchema({
  todos: s.table({
    title: s.string(),
    note: s.string(),
    priority: s.enum("low", "medium", "high"),
  }),
  workspaces: s.table({ name: s.string() }),
});

const appV1 = s.defineApp(v1);
const appV2 = s.defineApp(v2);

const migration = s.defineMigration({
  from: v1,
  to: v2,
  renameTables: { workspaces: s.renameTableFrom("projects") },
  migrate: {
    todos: {
      priority: s.add.enum("low", "medium", "high", { default: "medium" }),
      note: s.renameFrom("detail"),
      done: s.drop.boolean({ backwardsDefault: false }),
    },
  },
});

type PolicyRules = {
  allowInsert: { always(): void };
  allowRead: { always(): void };
  allowUpdate: { always(): void };
  allowDelete: { always(): void };
};
function allowAll(app: unknown, tables: string[]) {
  return s.definePermissions(
    app as Parameters<typeof s.definePermissions>[0],
    ({ policy }) => {
      const rules = policy as unknown as Record<string, PolicyRules>;
      for (const table of tables) {
        rules[table].allowInsert.always();
        rules[table].allowRead.always();
        rules[table].allowUpdate.always();
        rules[table].allowDelete.always();
      }
    },
  );
}
const permissionsV1 = allowAll(appV1, ["todos", "projects"]);
const permissionsV2 = allowAll(appV2, ["todos", "workspaces"]);

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

Deno.test("schema migrations carry data forward across add, drop, rename, and table rename", async () => {
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
      schema: appV1,
      permissions: permissionsV1,
    });
    const alice = await client(1);
    const todoV1 = await within(
      alice.insert(appV1.todos, { title: "first", done: true, detail: "carried" })
        .wait({ tier: "global" }),
      "v1 todo insert",
    );
    const projectV1 = await within(
      alice.insert(appV1.projects, { name: "renamed-table" }).wait({ tier: "global" }),
      "v1 project insert",
    );

    const unmigrated = await within(
      deploy({
        appId: server.appId,
        serverUrl: server.url,
        adminSecret: server.adminSecret,
        schema: appV2,
        permissions: permissionsV2,
      }).then(
        (result) => ({ outcome: "resolved" as const, result }),
        (error) => ({
          outcome: "rejected" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
      "v2 deploy without migration",
    );
    assert(
      unmigrated.outcome === "resolved" &&
        unmigrated.result.migration?.status === "missing",
      `deploy without a required migration no longer reports status "missing": ${
        JSON.stringify(unmigrated)
      }`,
    );

    await within(
      deploy({
        appId: server.appId,
        serverUrl: server.url,
        adminSecret: server.adminSecret,
        schema: appV2,
        permissions: permissionsV2,
        migration,
      }),
      "v2 deploy with migration",
    );

    // Forward lens: the v1 row arrives under v2 with the renamed column's
    // data, the added column's default, and without the dropped column.
    const bob = await client(2);
    const todosV2 = await within(
      bob.all(appV2.todos.where({ id: todoV1.id }), { tier: "global" }),
      "v2 todo read",
    );
    const migrated = todosV2[0];
    assert(migrated !== undefined, "v1 todo lost across the migration");
    assert(
      migrated.title === "first" && migrated.note === "carried",
      `renameFrom: v1 detail read back as note=${JSON.stringify(migrated.note)}`,
    );
    assert(
      migrated.priority === "medium",
      `add: v2 column read back ${JSON.stringify(migrated.priority)}, not its default`,
    );
    assert(
      !("done" in migrated),
      `drop: v1 column still present under v2: ${JSON.stringify(migrated)}`,
    );

    const workspacesV2 = await within(
      bob.all(appV2.workspaces.where({ id: projectV1.id }), { tier: "global" }),
      "v2 workspace read",
    );
    assert(
      workspacesV2.length === 1 && workspacesV2[0].name === "renamed-table",
      `renameTableFrom: v1 project row not readable under the renamed table`,
    );

    // Backward lens (generated automatically): a client still on v1 handles
    // reads a v2-written row with the rename reversed and the dropped
    // column's backwardsDefault filled in.
    const todoV2 = await within(
      bob.insert(appV2.todos, { title: "second", note: "fresh", priority: "high" })
        .wait({ tier: "global" }),
      "v2 todo insert",
    );
    const backward = (await within(
      alice.all(appV1.todos.where({ id: todoV2.id }), { tier: "global" }),
      "v1 read of v2 row",
    ))[0];
    assert(backward !== undefined, "v2 todo invisible to the v1 reader");
    assert(
      backward.title === "second" && backward.detail === "fresh",
      `backward rename: v2 note read back as detail=${JSON.stringify(backward.detail)}`,
    );
    assert(
      backward.done === false,
      `backward drop: backwardsDefault read back ${JSON.stringify(backward.done)}`,
    );
    assert(
      !("priority" in backward),
      `backward add: v2-only column leaked into the v1 view: ${JSON.stringify(backward)}`,
    );
  } finally {
    await Promise.allSettled(
      clients.map((db, index) => within(db.logout(), `client ${index} cleanup`, 3_000)),
    );
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
  }
});
