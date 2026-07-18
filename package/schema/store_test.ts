// Store-provisioning conformance over a real JazzServer: the classifier's
// four states, the create and slice-merge paths through the raw admin
// endpoints, old-hash client continuity across a merge, sibling-policy
// preservation (the honesty proof), and the namespace-confinement guards.
import { createDb } from "jazz-tools";
import { startLocalJazzServer } from "jazz-tools/testing";
import { assert } from "../runtime/test-assert.ts";
import { nestedAppDeployTarget, s } from "./mod.ts";
import { provisionStore, readStoreStatus, StoreProvisionError, type StoreTarget } from "./store.ts";

// The first app on the store.
const taskRoot = s.defineNestedApp({
  taskapp: { tasks: s.table({ text: s.string(), secret: s.boolean() }) },
});
const taskPermissions = s.defineNestedPermissions(taskRoot.taskapp, ({ policy, session }) => {
  policy.tasks.allowInsert.always();
  // The gate the second app's merge must preserve verbatim.
  policy.tasks.allowRead.where({ secret: false });
  policy.tasks.allowRead.where({ $createdBy: session.user_id });
  policy.tasks.allowUpdate.always();
  policy.tasks.allowDelete.always();
});

// The second app, enrolling later against the occupied store.
const noteRoot = s.defineNestedApp({
  notesapp: { notes: s.table({ title: s.string() }) },
});
const notePermissions = s.defineNestedPermissions(noteRoot.notesapp, ({ policy }) => {
  policy.notes.allowInsert.always();
  policy.notes.allowRead.always();
  policy.notes.allowUpdate.always();
  policy.notes.allowDelete.always();
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

Deno.test("a store is classified and provisioned slice by slice, preserving its other tenants", async () => {
  const server = await startLocalJazzServer({ allowLocalFirstAuth: true });
  const target: StoreTarget = {
    serverUrl: server.url,
    appId: server.appId,
    adminSecret: server.adminSecret,
  };
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
    // A fresh store has nothing deployed — the state where writes would hang.
    const empty = await readStoreStatus(taskRoot, target);
    assert(empty.state === "no_schema", `fresh store classified as ${empty.state}`);

    // Create: the first app's slice becomes the store schema.
    const created = await provisionStore({
      app: taskRoot,
      permissions: taskPermissions,
      target,
    });
    assert(created.status === "created", `initial provisioning reported ${created.status}`);
    const afterCreate = await readStoreStatus(taskRoot, target);
    assert(
      afterCreate.state === "ok" && afterCreate.headHash === created.headHash,
      `provisioned store classified as ${afterCreate.state}`,
    );
    const again = await provisionStore({ app: taskRoot, permissions: taskPermissions, target });
    assert(again.status === "unchanged", "re-provisioning an ok store must be a no-op");

    const alice = await client(1);
    const task = await within(
      alice.insert(taskRoot.taskapp.tasks, { text: "visible", secret: false })
        .wait({ tier: "global" }),
      "task insert after create",
    );
    await within(
      alice.insert(taskRoot.taskapp.tasks, { text: "hidden", secret: true })
        .wait({ tier: "global" }),
      "gated task insert",
    );

    // The second app sees the occupied store as out of date for ITS slice.
    const beforeMerge = await readStoreStatus(noteRoot, target);
    assert(
      beforeMerge.state === "schema_out_of_date" &&
        beforeMerge.missingTables.join(",") === "notesapp__notes",
      `second app classified the store as ${JSON.stringify(beforeMerge)}`,
    );

    // Merge: only notesapp tables are added; taskapp rides through verbatim.
    const merged = await provisionStore({
      app: noteRoot,
      permissions: notePermissions,
      target,
    });
    assert(merged.status === "updated", `slice merge reported ${merged.status}`);
    const afterMerge = await readStoreStatus(noteRoot, target);
    assert(afterMerge.state === "ok", `merged store classified as ${afterMerge.state} for notes`);
    const taskView = await readStoreStatus(taskRoot, target);
    assert(taskView.state === "ok", `merged store classified as ${taskView.state} for tasks`);

    // Old-hash continuity: the first app's client keeps working untouched.
    await within(
      alice.insert(taskRoot.taskapp.tasks, { text: "after merge", secret: false })
        .wait({ tier: "global" }),
      "old-hash insert after merge",
    );

    // The new slice is live for the joining app's own clients — provisioning
    // registered its compiled schema and connected it to the head, so its
    // declared hash is never disconnected.
    const bob = await client(2);
    await within(
      bob.insert(noteRoot.notesapp.notes, { title: "first note" }).wait({ tier: "global" }),
      "notes insert after merge",
    );

    // The honesty proof: notesapp's merge preserved taskapp's read gate. A
    // Db binds to one app's schema, so the non-author viewer is its own
    // client speaking the first app's handles.
    const carol = await client(3);
    const viewerTasks = await within(
      carol.all(taskRoot.taskapp.tasks.where({}), { tier: "global" }),
      "viewer task read after merge",
    );
    assert(
      viewerTasks.length === 2 && viewerTasks.every((row) => row.secret === false),
      `sibling policy not preserved: viewer sees ${viewerTasks.length} rows`,
    );
    const authorTasks = await within(
      alice.all(taskRoot.taskapp.tasks.where({ id: task.id }), { tier: "global" }),
      "author task read after merge",
    );
    assert(authorTasks.length === 1, "author lost access to pre-merge rows");

    // Drift: an app whose declaration disagrees with the store's copy of its
    // own namespace is surfaced and refused, never repaired.
    const driftedRoot = s.defineNestedApp({
      taskapp: { tasks: s.table({ text: s.string(), secret: s.boolean(), extra: s.int() }) },
    });
    const drifted = await readStoreStatus(driftedRoot, target);
    assert(
      drifted.state === "schema_drift" &&
        drifted.driftedTables.join(",") === "taskapp__tasks",
      `drifted app classified the store as ${JSON.stringify(drifted)}`,
    );
    const driftedPermissions = s.defineNestedPermissions(
      driftedRoot.taskapp,
      ({ policy }) => policy.tasks.allowRead.always(),
    );
    let driftError = "";
    try {
      await provisionStore({ app: driftedRoot, permissions: driftedPermissions, target });
    } catch (error) {
      driftError = error instanceof StoreProvisionError ? error.code : String(error);
    }
    assert(driftError === "schema-drift", `drifted provisioning reported "${driftError}"`);
  } finally {
    await Promise.allSettled(
      clients.map((db, index) => within(db.logout(), `client ${index} cleanup`, 3_000)),
    );
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
  }
});

Deno.test("provisioning is confined to the app's own namespaces", async () => {
  const target: StoreTarget = {
    serverUrl: "http://127.0.0.1:1",
    appId: "00000000-0000-0000-0000-000000000000",
    adminSecret: "unused",
  };

  // A flat app has no namespace and therefore no tenant boundary.
  const flat = s.defineApp({ tasks: s.table({ text: s.string() }) });
  let flatError = "";
  try {
    await readStoreStatus(flat, target);
  } catch (error) {
    flatError = error instanceof StoreProvisionError ? error.code : String(error);
  }
  assert(flatError === "not-nested", `flat app reported "${flatError}"`);

  // A permissions bundle naming a table outside the app's namespaces is a
  // hard error before any request is made (the target above is unreachable).
  const outOfSlug = {
    ...notePermissions,
    taskapp__tasks: (taskPermissions as Record<string, unknown>).taskapp__tasks,
  } as typeof notePermissions;
  let slugError = "";
  try {
    await provisionStore({ app: noteRoot, permissions: outOfSlug, target });
  } catch (error) {
    slugError = error instanceof StoreProvisionError ? error.code : String(error);
  }
  assert(slugError === "outside-namespace", `out-of-slug bundle reported "${slugError}"`);
});

Deno.test("the app slice derives from the deploy target's compiled schema", () => {
  const deployTarget = nestedAppDeployTarget(taskRoot) as { wasmSchema: Record<string, unknown> };
  assert(
    "taskapp__tasks" in deployTarget.wasmSchema,
    "expected the mangled table in the compiled wasm schema — the classifier compares this " +
      "form against the stored schema",
  );
});

Deno.test("the ticket store-status preflight maps every documented gate response", async () => {
  // A stub of the lofi-node gate's store-status endpoint (the contract in its
  // docs/app-ticket.md): 200 with metadata, 502 store_unavailable, 401
  // invalid_ticket, and 404 for nodes without the endpoint.
  const responses: Record<string, () => Response> = {
    "/t/deployed/store-status": () =>
      Response.json({
        v: 1,
        appId: "a-app",
        schema: { deployed: true, headHash: "ff85", permissionsHead: "0195" },
      }),
    "/t/fresh/store-status": () =>
      Response.json({ v: 1, appId: "a-app", schema: { deployed: false } }),
    "/t/down/store-status": () => Response.json({ error: "store_unavailable" }, { status: 502 }),
    "/t/revoked/store-status": () => Response.json({ error: "invalid_ticket" }, { status: 401 }),
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => responses[new URL(request.url).pathname]?.() ?? new Response("", { status: 404 }),
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  try {
    const { readTicketStoreStatus } = await import("./store.ts");
    const deployed = await readTicketStoreStatus(`${base}/t/deployed`);
    assert(
      deployed.state === "deployed" && deployed.headHash === "ff85" && deployed.appId === "a-app",
      `deployed store mapped to ${JSON.stringify(deployed)}`,
    );
    const fresh = await readTicketStoreStatus(`${base}/t/fresh`);
    assert(fresh.state === "no_schema", `fresh store mapped to ${JSON.stringify(fresh)}`);
    const down = await readTicketStoreStatus(`${base}/t/down`);
    assert(down.state === "store_unavailable", `502 mapped to ${JSON.stringify(down)}`);
    const revoked = await readTicketStoreStatus(`${base}/t/revoked`);
    assert(revoked.state === "ticket_rejected", `401 mapped to ${JSON.stringify(revoked)}`);
    const open = await readTicketStoreStatus(`${base}/t/missing`);
    assert(open.state === "unsupported", `404 mapped to ${JSON.stringify(open)}`);
  } finally {
    await server.shutdown();
  }
});
