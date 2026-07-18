// Concurrent-writer merge semantics for the facade's merge strategies:
// counter and g-set columns written by two synced clients. Single-session
// behavior is covered by the conformance suite; this file is the multi-client
// half, built on the JazzServer setup from package/access/access_sync_test.ts.
//
// Runs in its own process before the conformance suite (see the
// test:conformance task) because the conformance scalar test deliberately
// wedges the FFI driver last.
import { createDb } from "jazz-tools";
import { deploy, startLocalJazzServer } from "jazz-tools/testing";
import { assert } from "../runtime/test-assert.ts";
import { type ArrayColumn, type IntColumn, s } from "./mod.ts";

const counterApp = s.defineApp({
  tallies: s.table({
    name: s.string(),
    total: s.int().default(0).merge("counter") as unknown as IntColumn<false, true>,
  }),
});
const counterPermissions = s.definePermissions(counterApp, ({ policy }) => {
  policy.tallies.allowInsert.always();
  policy.tallies.allowRead.always();
  policy.tallies.allowUpdate.always();
  policy.tallies.allowDelete.always();
});

// Single-table app: a g-set column destabilizes sibling-table writes in the
// pinned alpha (see the conformance canary), so the g-set coverage stays
// isolated here too.
const gsetApp = s.defineApp({
  tagged: s.table({
    name: s.string(),
    tags: s.array(s.string()).merge("g-set") as unknown as ArrayColumn<"TEXT">,
  }),
});
const gsetPermissions = s.definePermissions(gsetApp, ({ policy }) => {
  policy.tagged.allowInsert.always();
  policy.tagged.allowRead.always();
  policy.tagged.allowUpdate.always();
  policy.tagged.allowDelete.always();
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

type DeployOptions = Parameters<typeof deploy>[0];
type Harness = {
  server: Awaited<ReturnType<typeof startLocalJazzServer>>;
  client(fill: number): Promise<Awaited<ReturnType<typeof createDb>>>;
  stop(): Promise<void>;
};

async function bootHarness(
  app: DeployOptions["schema"],
  permissions: DeployOptions["permissions"],
): Promise<Harness> {
  const server = await startLocalJazzServer({ allowLocalFirstAuth: true });
  await deploy({
    appId: server.appId,
    serverUrl: server.url,
    adminSecret: server.adminSecret,
    schema: app,
    permissions,
  });
  const clients: Awaited<ReturnType<typeof createDb>>[] = [];
  return {
    server,
    async client(fill: number) {
      const db = await createDb({
        appId: server.appId,
        serverUrl: server.url,
        secret: secret(fill),
        userBranch: "main",
        driver: { type: "memory" },
      });
      clients.push(db);
      return db;
    },
    async stop() {
      await Promise.allSettled(
        clients.map((db, index) => within(db.logout(), `client ${index} cleanup`, 3_000)),
      );
      await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
    },
  };
}

// PINNED (alpha.53): counter columns have no single semantics across replica
// lifetimes. The server merges an update as a replacement when it is causally
// latest and as a sum when updates are concurrent, while live replicas apply
// every update — including the echo of their own reconnected write — as a
// delta. A replica that watched the history read therefore diverges
// permanently from what a fresh boot of the same account reads. Each assert
// below pins one cell of that matrix; when one fails, upstream changed
// counter merge behavior — re-derive the matrix and update the column-palette
// section of docs/data-and-ui.md.
Deno.test("counter merge: concurrent offline updates sum on the server, diverge on a live writer", async () => {
  const harness = await bootHarness(counterApp, counterPermissions);
  try {
    const alice = await harness.client(1);
    const bob = await harness.client(2);
    const row = await within(
      alice.insert(counterApp.tallies, { name: "hits", total: 0 }).wait({ tier: "global" }),
      "seed insert",
    );
    const bobView = await within(
      bob.all(counterApp.tallies.where({ id: row.id }), { tier: "global" }),
      "bob initial read",
    );
    assert(bobView.length === 1 && bobView[0].total === 0, "bob did not sync the seeded row");

    await alice.disconnect();
    await bob.disconnect();
    const aliceWrite = alice.update(counterApp.tallies, row.id, { total: 5 });
    const bobWrite = bob.update(counterApp.tallies, row.id, { total: 3 });
    await alice.reconnect();
    await bob.reconnect();
    await within(aliceWrite.wait({ tier: "global" }), "alice counter durability");
    await within(bobWrite.wait({ tier: "global" }), "bob counter durability");

    const read = async (db: typeof alice, label: string) => {
      const rows = await within(
        db.all(counterApp.tallies.where({ id: row.id }), { tier: "global" }),
        `${label} read`,
      );
      return rows[0]?.total;
    };
    const aliceTotal = await read(alice, "alice");
    const bobTotal = await read(bob, "bob");
    const charlie = await harness.client(3);
    const canonical = await read(charlie, "fresh client");

    assert(
      canonical === 8,
      `counter: concurrent updates no longer sum on the server (fresh client read ${canonical}, ` +
        `not 5 + 3); the merge model changed — remap it`,
    );
    assert(
      bobTotal === 8,
      `counter: second writer read ${bobTotal}, not the canonical sum 8`,
    );
    assert(
      aliceTotal === 13,
      `counter: pinned first-writer divergence changed — read ${aliceTotal}; if 8, upstream ` +
        `stopped double-counting the reconnected writer's own echo: remove the pin`,
    );
  } finally {
    await harness.stop();
  }
});

Deno.test("counter merge: causally ordered updates replace on the server, accumulate on live replicas", async () => {
  const harness = await bootHarness(counterApp, counterPermissions);
  try {
    const alice = await harness.client(1);
    const bob = await harness.client(2);
    const row = await within(
      alice.insert(counterApp.tallies, { name: "causal", total: 0 }).wait({ tier: "global" }),
      "seed insert",
    );
    await within(
      alice.update(counterApp.tallies, row.id, { total: 2 }).wait({ tier: "global" }),
      "alice update durability",
    );
    const bobBefore = await within(
      bob.all(counterApp.tallies.where({ id: row.id }), { tier: "global" }),
      "bob pre-write read",
    );
    assert(bobBefore[0]?.total === 2, "bob did not sync alice's update before writing");
    await within(
      bob.update(counterApp.tallies, row.id, { total: 3 }).wait({ tier: "global" }),
      "bob update durability",
    );

    const bobTotal =
      (await within(bob.all(counterApp.tallies.where({ id: row.id })), "bob read"))[0]?.total;
    const aliceTotal = (await within(
      alice.all(counterApp.tallies.where({ id: row.id }), { tier: "global" }),
      "alice read",
    ))[0]?.total;
    const charlie = await harness.client(3);
    const canonical = (await within(
      charlie.all(counterApp.tallies.where({ id: row.id }), { tier: "global" }),
      "fresh client read",
    ))[0]?.total;

    assert(
      canonical === 3,
      `counter: pinned causal replacement changed — fresh client read ${canonical}; if 5, ` +
        `upstream now sums causally ordered updates like live replicas do: remove the pin`,
    );
    assert(
      aliceTotal === 5 && bobTotal === 5,
      `counter: live replicas no longer accumulate deltas (alice=${aliceTotal}, bob=${bobTotal}, ` +
        `expected both 5 = 2 + 3)`,
    );
  } finally {
    await harness.stop();
  }
});

Deno.test("g-set columns union concurrent offline updates and converge everywhere", async () => {
  const harness = await bootHarness(gsetApp, gsetPermissions);
  try {
    const alice = await harness.client(1);
    const bob = await harness.client(2);
    const row = await within(
      alice.insert(gsetApp.tagged, { name: "doc", tags: ["a"] }).wait({ tier: "global" }),
      "seed insert",
    );
    const bobView = await within(
      bob.all(gsetApp.tagged.where({ id: row.id }), { tier: "global" }),
      "bob initial read",
    );
    assert(bobView.length === 1, "bob did not sync the seeded row");

    await alice.disconnect();
    await bob.disconnect();
    const aliceWrite = alice.update(gsetApp.tagged, row.id, { tags: ["a", "b"] });
    const bobWrite = bob.update(gsetApp.tagged, row.id, { tags: ["a", "c"] });
    await alice.reconnect();
    await bob.reconnect();
    await within(aliceWrite.wait({ tier: "global" }), "alice g-set durability");
    await within(bobWrite.wait({ tier: "global" }), "bob g-set durability");

    const read = async (db: typeof alice, label: string) => {
      const rows = await within(
        db.all(gsetApp.tagged.where({ id: row.id }), { tier: "global" }),
        `${label} read`,
      );
      return [...(rows[0]?.tags ?? [])].sort();
    };
    const aliceTags = await read(alice, "alice");
    const bobTags = await read(bob, "bob");
    const charlie = await harness.client(3);
    const canonical = await read(charlie, "fresh client");

    const union = JSON.stringify(["a", "b", "c"]);
    for (
      const [label, tags] of [["alice", aliceTags], ["bob", bobTags], ["fresh client", canonical]]
        .map(([l, t]) => [l, JSON.stringify(t)] as const)
    ) {
      assert(
        tags === union,
        `g-set: ${label} read ${tags}, not the union of both writers' elements`,
      );
    }
  } finally {
    await harness.stop();
  }
});
