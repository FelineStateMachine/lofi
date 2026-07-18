// Column-type conformance: every data shape the schema facade exposes must
// round-trip through the real pinned Jazz engine — insert, read-back, where
// filtering, update, modifiers, and policy matching. A member that only
// compiles is not supported; this suite is what fails when an alpha bump
// changes engine behavior for a column type the facade exports.
//
// Uses only the facade surface (`s` from ./mod.ts) so the suite proves what an
// application author can actually reach.
import { createPolicyTestApp } from "jazz-tools/testing";
import { assert } from "../runtime/test-assert.ts";
import { type ArrayColumn, type IntColumn, s } from "./mod.ts";

const app = s.defineApp({
  parents: s.table({ name: s.string() }),
  strings: s.table({ value: s.string() }),
  booleans: s.table({ value: s.boolean() }),
  ints: s.table({ value: s.int() }),
  floats: s.table({ value: s.float() }),
  timestamps: s.table({ value: s.timestamp() }),
  blobs: s.table({ value: s.bytes() }),
  jsons: s.table({ value: s.json() }),
  enums: s.table({ value: s.enum("draft", "published", "archived") }),
  refs: s.table({ parentId: s.ref("parents"), label: s.string() }),
  arrays: s.table({ value: s.array(s.string()) }),
  modifiers: s.table({
    required: s.string(),
    note: s.string().optional(),
    label: s.string().default("untitled"),
    // CONFORMANCE FINDING (alpha.53): `.merge()` returns the untyped builder
    // because the legacy `merge(): this` signature shadows the typed overload,
    // which poisons the whole table's row types. The cast restores the typed
    // column; the runtime object is correct without it.
    total: s.int().default(0).merge("counter") as unknown as IntColumn<false, true>,
  }),
  gated: s.table({ visible: s.boolean(), title: s.string() }),
});

// CONFORMANCE FINDING (alpha.53): a `g-set` column anywhere in a schema makes
// writes to *other* tables in the same app hang forever (bisected via a
// cumulative table-by-table probe; boots fine, first cross-table write never
// resolves). The g-set coverage therefore lives in its own single-table app,
// and the hang itself is pinned by the subprocess canary test below.
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

const allowAllTables = [
  "parents",
  "strings",
  "booleans",
  "ints",
  "floats",
  "timestamps",
  "blobs",
  "jsons",
  "enums",
  "refs",
  "arrays",
  "modifiers",
] as const;

type RuleSet = {
  always(): void;
  where(condition: Record<string, unknown>): void;
};
type TableRules = Record<"allowInsert" | "allowRead" | "allowUpdate" | "allowDelete", RuleSet>;

const permissions = s.definePermissions(app, ({ policy }) => {
  const rules = policy as unknown as Record<string, TableRules>;
  for (const table of allowAllTables) {
    rules[table].allowInsert.always();
    rules[table].allowRead.always();
    rules[table].allowUpdate.always();
    rules[table].allowDelete.always();
  }
  // Policy conditions must match over a typed column, not only magic columns.
  policy.gated.allowInsert.always();
  policy.gated.allowRead.where({ visible: true });
  policy.gated.allowUpdate.always();
  policy.gated.allowDelete.always();
});

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

function sameValue(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Date) {
    return actual instanceof Date
      ? actual.getTime() === expected.getTime()
      : actual === expected.getTime();
  }
  if (expected instanceof Uint8Array) {
    return actual instanceof Uint8Array &&
      actual.length === expected.length &&
      expected.every((byte, index) => actual[index] === byte);
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => sameValue(actual[index], item));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return false;
    const expectedEntries = Object.entries(expected);
    return expectedEntries.length === Object.keys(actual).length &&
      expectedEntries.every(([key, item]) =>
        sameValue((actual as Record<string, unknown>)[key], item)
      );
  }
  return actual === expected;
}

function describeValue(value: unknown): string {
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})[${value.join(",")}]`;
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  return JSON.stringify(value);
}

// One representative and one contrasting value per scalar column family. The
// contrasting value proves where-equality actually filters instead of
// matching everything.
const scalarCases = [
  { table: "strings", value: "héllo wörld", other: "" },
  { table: "booleans", value: true, other: false },
  // CONFORMANCE FINDING (alpha.53): int columns are i32 at runtime despite
  // the `number` static type — see the i64 rejection pin below.
  { table: "ints", value: 2_147_483_640, other: -1 },
  { table: "floats", value: 3.141592653589793, other: -0.5 },
  // PINNED (alpha.53): where-equality on a timestamp column matches every
  // row (verified with distinct non-epoch dates). When the pinned count
  // below reads 1 again, upstream fixed the comparison — clear the flag.
  {
    table: "timestamps",
    value: new Date("2026-07-18T12:34:56.789Z"),
    other: new Date("2001-02-03T04:05:06.007Z"),
    brokenWhereEquality: true,
  },
  { table: "enums", value: "published", other: "draft" },
] as const;

// The scalar sweep iterates tables dynamically, which steps outside the typed
// query surface; these loose structural views cover only the sweep. The
// structured-columns test below stays fully typed.
type Row = { id: string } & Record<string, unknown>;
type LooseHandle = { where(condition: Record<string, unknown>): unknown };
type LooseDb = {
  insert(table: unknown, values: unknown): { wait(opts: { tier: "global" }): Promise<Row> };
  update(table: unknown, id: string, patch: unknown): { wait(opts: { tier: "global" }): unknown };
  all(query: unknown): Promise<Row[]>;
};

Deno.test("facade structured columns (bytes, json, array, ref) round-trip through the real engine", async () => {
  const testApp = await createPolicyTestApp(app, permissions, expectLike);
  try {
    const db = testApp.as(session("author"));

    const payload = new Uint8Array(32).map((_, index) => (index * 37) % 256);
    const blob = await db.insert(app.blobs, { value: payload }).wait({ tier: "global" });
    const blobRows = await db.all(app.blobs.where({ id: blob.id }));
    assert(
      blobRows.length === 1 && sameValue(blobRows[0].value, payload),
      `bytes: read back ${describeValue(blobRows[0]?.value)}`,
    );

    const document = { nested: { list: [1, "two", null], flag: true }, empty: {} };
    const json = await db.insert(app.jsons, { value: document }).wait({ tier: "global" });
    const jsonRows = await db.all(app.jsons.where({ id: json.id }));
    assert(
      jsonRows.length === 1 && sameValue(jsonRows[0].value, document),
      `json: read back ${describeValue(jsonRows[0]?.value)}`,
    );

    const items = ["alpha", "beta", "beta"];
    const array = await db.insert(app.arrays, { value: items }).wait({ tier: "global" });
    const arrayRows = await db.all(app.arrays.where({ id: array.id }));
    assert(
      arrayRows.length === 1 && sameValue(arrayRows[0].value, items),
      `array: read back ${describeValue(arrayRows[0]?.value)}`,
    );

    const parent = await db.insert(app.parents, { name: "parent" }).wait({ tier: "global" });
    const decoy = await db.insert(app.parents, { name: "decoy" }).wait({ tier: "global" });
    await db.insert(app.refs, { parentId: parent.id, label: "child" }).wait({ tier: "global" });
    await db.insert(app.refs, { parentId: decoy.id, label: "other" }).wait({ tier: "global" });
    const children = await db.all(app.refs.where({ parentId: parent.id }));
    assert(
      children.length === 1 && children[0].label === "child",
      `ref: where on the foreign key returned ${children.length} rows`,
    );
  } finally {
    await testApp.shutdown();
  }
});

Deno.test("facade column modifiers (optional, default, counter, g-set) behave through the real engine", async () => {
  const testApp = await createPolicyTestApp(app, permissions, expectLike);
  try {
    const db = testApp.as(session("author"));

    const row = await db.insert(app.modifiers, { required: "present" })
      .wait({ tier: "global" });
    const readBack = (await db.all(app.modifiers.where({ id: row.id })))[0];
    assert(readBack !== undefined, "modifiers: row lost after insert");
    assert(
      readBack.note === null || readBack.note === undefined,
      `optional: omitted column read back as ${describeValue(readBack.note)}`,
    );
    assert(
      readBack.label === "untitled",
      `default: omitted column read back as ${describeValue(readBack.label)}`,
    );
    assert(
      readBack.total === 0,
      `counter default: read back ${describeValue(readBack.total)}`,
    );

    // Single-session semantics only; concurrent-writer merge behavior is
    // pinned in ./merge_sync_test.ts, which runs first in its own process.
    await db.update(app.modifiers, row.id, { total: 5 }).wait({ tier: "global" });
    const bumped = (await db.all(app.modifiers.where({ id: row.id })))[0];
    assert(bumped !== undefined, "modifiers: row lost after update");
    assert(bumped.total === 5, `counter: update read back ${describeValue(bumped.total)}`);

    await db.update(app.modifiers, row.id, { note: "written" }).wait({ tier: "global" });
    const cleared = (await db.all(app.modifiers.where({ id: row.id })))[0];
    assert(cleared?.note === "written", "optional: column did not accept a value");
  } finally {
    await testApp.shutdown();
  }
});

Deno.test("g-set columns round-trip inside their own single-table app", async () => {
  const testApp = await createPolicyTestApp(gsetApp, gsetPermissions, expectLike);
  try {
    const db = testApp.as(session("author"));
    const row = await db.insert(gsetApp.tagged, { name: "first", tags: ["a"] })
      .wait({ tier: "global" });
    await db.update(gsetApp.tagged, row.id, { tags: ["a", "b"] }).wait({ tier: "global" });
    const readBack = (await db.all(gsetApp.tagged.where({ id: row.id })))[0];
    assert(readBack !== undefined, "g-set: row lost after update");
    assert(
      sameValue(readBack.tags, ["a", "b"]),
      `g-set: update read back ${describeValue(readBack.tags)}`,
    );
  } finally {
    await testApp.shutdown();
  }
});

async function runGsetCanary(mode: "sibling-first" | "gset-first"): Promise<string> {
  const script = new URL("../testdata/gset_hang_canary.ts", import.meta.url);
  const repoRoot = new URL("../../", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-net=127.0.0.1",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-ffi",
      script.pathname,
      mode,
    ],
    cwd: repoRoot.pathname,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return new TextDecoder().decode(output.stdout);
}

Deno.test("CANARY alpha.53: short byte payloads are unreliable", async () => {
  // A 2-byte insert has been observed succeeding, failing with the
  // flat-history encoder error ("data too short for column value"), and
  // hanging — context-dependent, so it runs behind a race in a child process
  // and every known mode is accepted. An unknown error message is the only
  // failure: it means the encoder changed and the bytes coverage should be
  // revisited (ideally widened to short payloads).
  const script = new URL("../testdata/bytes_short_payload_canary.ts", import.meta.url);
  const repoRoot = new URL("../../", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-net=127.0.0.1",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-ffi",
      script.pathname,
    ],
    cwd: repoRoot.pathname,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const known = stdout.includes("short-bytes:OK") ||
    stdout.includes("short-bytes:HUNG") ||
    (stdout.includes("short-bytes:ERROR") && stdout.includes("data too short"));
  assert(known, `bytes canary: unknown short-payload behavior: ${stdout}`);
  console.log(`[conformance] ${stdout.trim()}`);
});

Deno.test("CANARY alpha.53: g-set cross-table writes are unreliable", async () => {
  // Writing a sibling table before a g-set table's first write hangs
  // reproducibly inside a process that has already booted policy test
  // harnesses (five independent bisection runs), but not always in a fresh
  // process — the wedge depends on process state, like the timestamp-query
  // wedge documented on the scalar test. Both modes therefore run in child
  // processes that force-exit, and either outcome is accepted and reported;
  // only an outright error is a failure. The g-set coverage stays isolated in
  // its own single-table app until upstream stabilizes this.
  const siblingFirst = await runGsetCanary("sibling-first");
  assert(
    siblingFirst.includes("sibling-table-write:OK") ||
      siblingFirst.includes("sibling-table-write:HUNG"),
    `g-set canary: unexpected sibling-first outcome: ${siblingFirst}`,
  );
  console.log(`[conformance] g-set sibling-first: ${siblingFirst.trim()}`);

  const gsetFirst = await runGsetCanary("gset-first");
  assert(
    gsetFirst.includes("gset-table-write:OK") && gsetFirst.includes("sibling-table-write:OK"),
    `g-set canary: seeding the g-set table first no longer unblocks sibling writes: ${gsetFirst}`,
  );
});

Deno.test("policies filter on typed columns, not only magic columns", async () => {
  const testApp = await createPolicyTestApp(app, permissions, expectLike);
  try {
    const db = testApp.as(session("author"));
    await db.insert(app.gated, { visible: true, title: "shown" }).wait({ tier: "global" });
    await db.insert(app.gated, { visible: false, title: "hidden" }).wait({ tier: "global" });
    const readable = await db.all(app.gated.where({}));
    assert(
      readable.length === 1 && readable[0].title === "shown",
      `gated: policy on a boolean column exposed ${readable.length} rows`,
    );
  } finally {
    await testApp.shutdown();
  }
});

// CONFORMANCE FINDING (alpha.53): this test runs LAST deliberately. Running
// the broken timestamp where-equality query (pinned below) leaves the FFI
// driver wedged: the next createPolicyTestApp boot in the same process hangs
// on its first write. Observed across three orderings; tests that run before
// this one are unaffected.
Deno.test("facade scalar columns round-trip, filter, and update through the real engine", async () => {
  const testApp = await createPolicyTestApp(app, permissions, expectLike);
  try {
    const db = testApp.as(session("author")) as unknown as LooseDb;
    const handles = app as unknown as Record<string, LooseHandle>;
    for (const { table, value, other } of scalarCases) {
      const handle = handles[table];
      const inserted = await db.insert(handle, { value }).wait({ tier: "global" });
      await db.insert(handle, { value: other }).wait({ tier: "global" });

      const byId = await db.all(handle.where({ id: inserted.id }));
      assert(byId.length === 1, `${table}: row lost after insert`);
      assert(
        sameValue(byId[0].value, value),
        `${table}: read back ${describeValue(byId[0].value)}, inserted ${describeValue(value)}`,
      );

      const byValue = await db.all(handle.where({ value }));
      if ("brokenWhereEquality" in scalarCases.find((c) => c.table === table)!) {
        assert(
          byValue.length === 2,
          `${table}: pinned broken where-equality changed — returned ${byValue.length} rows; ` +
            `if 1, upstream fixed the filter: remove the pin`,
        );
      } else {
        assert(
          byValue.length === 1 && byValue[0].id === inserted.id,
          `${table}: where-equality on the typed column returned ${byValue.length} rows`,
        );
      }

      await db.update(handle, inserted.id, { value: other }).wait({ tier: "global" });
      const afterUpdate = await db.all(handle.where({ id: inserted.id }));
      assert(
        afterUpdate.length === 1 && sameValue(afterUpdate[0].value, other),
        `${table}: update read back ${describeValue(afterUpdate[0]?.value)}`,
      );
    }

    // PINNED (alpha.53): despite the `number` static type, int columns reject
    // values outside i32 with InvalidArg. When this pin fails, upstream
    // widened the runtime type — update the docs and the scalar case above.
    let i64Error = "";
    try {
      await db.insert(handles.ints, { value: 2 ** 40 + 7 }).wait({ tier: "global" });
    } catch (error) {
      i64Error = error instanceof Error ? error.message : String(error);
    }
    assert(
      i64Error.includes("expected i32"),
      `ints: pinned i32 limit changed: ${i64Error || "no error thrown"}`,
    );
  } finally {
    await testApp.shutdown();
  }
});
