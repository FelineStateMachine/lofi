// Sliceable-app conformance: the facade decision record deferred
// `defineSliceableApp` as unexercised; this suite is the coverage that lets
// it join the surface. Slice-derived handles must query the real engine,
// per-slice permissions must compile and merge into one deployable bundle,
// and the migration surface must work over a sliced schema — nothing here
// may rely on `defineApp`.
import { createDb } from "jazz-tools";
import { createPolicyTestApp, deploy, startLocalJazzServer } from "jazz-tools/testing";
import { assert } from "../runtime/test-assert.ts";
import { s } from "./mod.ts";

const app = s.defineSliceableApp({
  workspaces: s.table({ name: s.string() }),
  tasks: s.table({ workspaceId: s.ref("workspaces"), text: s.string() }),
  notes: s.table({ title: s.string(), secret: s.boolean() }),
});

// One slice per sub-app view; each slice call derives fresh typed handles
// over the same compiled schema.
const taskSlice = app.slice("workspaces", "tasks");
const noteSlice = app.slice("notes");
const deploySlice = app.slice("workspaces", "tasks", "notes");

const taskPermissions = s.definePermissions(taskSlice, ({ policy }) => {
  policy.workspaces.allowInsert.always();
  policy.workspaces.allowRead.always();
  policy.tasks.allowInsert.always();
  policy.tasks.allowRead.always();
  policy.tasks.allowUpdate.always();
  policy.tasks.allowDelete.always();
});
const notePermissions = s.definePermissions(noteSlice, ({ policy, session }) => {
  policy.notes.allowInsert.always();
  // Non-secret notes are public; secret notes only readable by their author.
  policy.notes.allowRead.where({ secret: false });
  policy.notes.allowRead.where({ $createdBy: session.user_id });
});

const mergedPermissions = s.mergeNestedPermissions(taskPermissions, notePermissions);

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

Deno.test("slices select declared tables and reject unknown ones", () => {
  assert(
    "tasks" in taskSlice && !("notes" in taskSlice),
    "slice exposes tables outside its selection",
  );
  assert(
    "notes" in noteSlice && !("tasks" in noteSlice),
    "single-table slice exposes unselected tables",
  );
  let message = "";
  try {
    app.slice("nonexistent" as never);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(
    message.includes('unknown table "nonexistent"'),
    `slice of an unknown table reported: ${message || "no error"}`,
  );
});

Deno.test("slice-derived handles query the one real store, and merged per-slice policies bind to their tables", async () => {
  const testApp = await createPolicyTestApp(
    deploySlice as never,
    mergedPermissions,
    expectLike,
  );
  try {
    const db = testApp.as(session("author"));

    // Writes through one slice's handles are visible through another slice's
    // fresh handles: slices are views over one schema, not separate stores.
    const workspace = await db.insert(taskSlice.workspaces, { name: "home" })
      .wait({ tier: "global" });
    await db.insert(taskSlice.tasks, { workspaceId: workspace.id, text: "write tests" })
      .wait({ tier: "global" });
    const secondTaskSlice = app.slice("tasks");
    const tasks = await db.all(secondTaskSlice.tasks.where({ workspaceId: workspace.id }));
    assert(
      tasks.length === 1 && tasks[0].text === "write tests",
      `fresh slice handle read ${tasks.length} rows through the shared store`,
    );

    // The merged bundle keeps each slice's policy on its own table: tasks
    // stay allow-all while the notes policy still gates secret rows.
    await db.insert(noteSlice.notes, { title: "public", secret: false }).wait({ tier: "global" });
    await db.insert(noteSlice.notes, { title: "private", secret: true }).wait({ tier: "global" });
    const authorNotes = await db.all(noteSlice.notes.where({}));
    assert(
      authorNotes.length === 2,
      `author reads ${authorNotes.length} notes, expected both alternatives to apply`,
    );
    const viewer = testApp.as(session("viewer"));
    const viewerNotes = await viewer.all(noteSlice.notes.where({}));
    assert(
      viewerNotes.length === 1 && viewerNotes[0].title === "public",
      `merged notes policy exposed ${viewerNotes.length} rows to a non-author`,
    );
    const viewerTasks = await viewer.all(taskSlice.tasks.where({}));
    assert(
      viewerTasks.length === 1,
      `merged tasks policy exposed ${viewerTasks.length} rows, expected allow-all read`,
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

Deno.test("migrations carry data forward over a sliced schema", async () => {
  const v1 = s.defineSchema({
    items: s.table({ label: s.string(), obsolete: s.boolean() }),
  });
  const v2 = s.defineSchema({
    entries: s.table({ label: s.string(), priority: s.enum("low", "high") }),
  });
  const sliceV1 = s.defineSliceableApp(v1).slice("items");
  const sliceV2 = s.defineSliceableApp(v2).slice("entries");
  const migration = s.defineMigration({
    from: v1,
    to: v2,
    renameTables: { entries: s.renameTableFrom("items") },
    migrate: {
      entries: {
        priority: s.add.enum("low", "high", { default: "low" }),
        obsolete: s.drop.boolean({ backwardsDefault: false }),
      },
    },
  });
  const allowAll = (slice: never, table: string) =>
    s.definePermissions(slice, ({ policy }) => {
      const rules = (policy as unknown as Record<
        string,
        Record<"allowInsert" | "allowRead" | "allowUpdate" | "allowDelete", { always(): void }>
      >)[table];
      rules.allowInsert.always();
      rules.allowRead.always();
      rules.allowUpdate.always();
      rules.allowDelete.always();
    });

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
      schema: sliceV1,
      permissions: allowAll(sliceV1 as never, "items"),
    });
    const alice = await client(1);
    const itemV1 = await within(
      alice.insert(sliceV1.items, { label: "carried", obsolete: true }).wait({ tier: "global" }),
      "v1 item insert",
    );

    await within(
      deploy({
        appId: server.appId,
        serverUrl: server.url,
        adminSecret: server.adminSecret,
        schema: sliceV2,
        permissions: allowAll(sliceV2 as never, "entries"),
        migration,
      }),
      "v2 deploy with migration",
    );

    const bob = await client(2);
    const entries = await within(
      bob.all(sliceV2.entries.where({ id: itemV1.id }), { tier: "global" }),
      "v2 entry read",
    );
    assert(entries.length === 1, "v1 row lost across the sliced-schema migration");
    assert(
      entries[0].label === "carried" && entries[0].priority === "low",
      `sliced migration read back ${JSON.stringify(entries[0])}`,
    );
    assert(
      !("obsolete" in entries[0]),
      `dropped column survived the sliced migration: ${JSON.stringify(entries[0])}`,
    );
  } finally {
    await Promise.allSettled(
      clients.map((db, index) => within(db.logout(), `client ${index} cleanup`, 3_000)),
    );
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
  }
});
