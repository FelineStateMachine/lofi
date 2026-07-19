// privateTable contract: every column seals by default with a derived label,
// refs and plain-marked columns stay plaintext, bytes stay plaintext with a
// report, and configurations the seal boundary cannot honor are refused.
import { clearEncryptedColumnRegistry, encryptedColumnsOf, s } from "./mod.ts";
import {
  clearEncryptedColumnKey,
  encryptedColumnLabelOf,
  setEncryptedColumnKey,
} from "./encrypted.ts";
import { assert } from "../runtime/test-assert.ts";

function expectTypeError(run: () => unknown, needle: string, context: string): void {
  try {
    run();
  } catch (error) {
    assert(
      error instanceof TypeError && error.message.includes(needle),
      `${context}: expected a TypeError mentioning "${needle}", received ${String(error)}`,
    );
    return;
  }
  throw new Error(`${context}: expected a refusal, but the call succeeded`);
}

Deno.test("privateTable seals every column type with derived labels", () => {
  clearEncryptedColumnRegistry();
  try {
    const table = s.privateTable("vault", {
      body: s.string(),
      score: s.int(),
      ratio: s.float(),
      at: s.timestamp(),
      done: s.boolean(),
      kind: s.enum("a", "b"),
      meta: s.json(),
      tags: s.array(s.string()),
      workspaceId: s.ref("workspaces"),
      title: s.plain(s.string()),
    });
    const columns = table.columns as Record<string, unknown>;
    for (const sealedName of ["body", "score", "ratio", "at", "done", "kind", "meta", "tags"]) {
      assert(
        encryptedColumnLabelOf(columns[sealedName]) === `vault.${sealedName}`,
        `column "${sealedName}" did not seal with the derived label`,
      );
    }
    assert(
      encryptedColumnLabelOf(columns.workspaceId) === undefined,
      "a ref column must stay plaintext",
    );
    assert(
      encryptedColumnLabelOf(columns.title) === undefined,
      "a plain-marked column must stay plaintext",
    );

    // Defining an app over the table registers the sealed columns.
    s.defineApp({ vault: table } as never);
    const registered = encryptedColumnsOf("vault");
    assert(
      registered !== undefined && registered.size === 8 &&
        registered.get("body") === "vault.body",
      "privateTable columns did not register through defineApp",
    );
  } finally {
    clearEncryptedColumnRegistry();
  }
});

Deno.test("privateTable sealed values round-trip through the transforms", () => {
  setEncryptedColumnKey(new Uint8Array(32).map((_, index) => index + 1));
  clearEncryptedColumnRegistry();
  try {
    const table = s.privateTable("roundtrip", {
      done: s.boolean(),
      kind: s.enum("draft", "final"),
      tags: s.array(s.string()),
    });
    const columns = table.columns as Record<string, {
      _transform?: { to(value: unknown): string; from(value: string): unknown };
    }>;
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["done", true],
      ["kind", "final"],
      ["tags", ["a", "b"]],
    ];
    for (const [name, value] of cases) {
      const transform = columns[name]._transform;
      assert(transform !== undefined, `sealed column "${name}" carries no transform`);
      const stored = transform.to(value);
      assert(stored.startsWith("enc2."), `sealed column "${name}" stored an unsealed value`);
      assert(
        JSON.stringify(transform.from(stored)) === JSON.stringify(value),
        `sealed column "${name}" did not round-trip`,
      );
    }
  } finally {
    clearEncryptedColumnKey();
    clearEncryptedColumnRegistry();
  }
});

Deno.test("privateTable refuses configurations the seal boundary cannot honor", () => {
  clearEncryptedColumnRegistry();
  try {
    expectTypeError(
      () => s.privateTable("bad", { note: s.string().optional() }),
      "optional",
      "optional column",
    );
    expectTypeError(
      () => s.privateTable("bad", { note: s.string().default("x") }),
      "default",
      "defaulted column",
    );
    // The alpha.53 legacy signatures degrade .merge()/.transform() to the
    // untyped builder, hence the casts (see the modifier note in mod.ts).
    expectTypeError(
      () => s.privateTable("bad", { tags: s.array(s.string()).merge("g-set") as never }),
      "merge",
      "non-lww merge",
    );
    expectTypeError(
      () =>
        s.privateTable("bad", {
          csv: s.string().transform({
            from: (value: string) => value.split(","),
            to: (value: string[]) => value.join(","),
          }) as never,
        }),
      "transform",
      "transformed column",
    );
    expectTypeError(() => s.privateTable("  ", { note: s.string() }), "prefix", "empty prefix");
  } finally {
    clearEncryptedColumnRegistry();
  }
});

Deno.test("privateTable passes through author-sealed and byte columns", () => {
  clearEncryptedColumnRegistry();
  try {
    const explicit = s.encryptedText("custom.label");
    const table = s.privateTable("mixed", {
      note: explicit,
      raw: s.bytes(),
    });
    const columns = table.columns as Record<string, unknown>;
    assert(
      encryptedColumnLabelOf(columns.note) === "custom.label",
      "an author-sealed column must keep its own label",
    );
    assert(
      encryptedColumnLabelOf(columns.raw) === undefined,
      "a bytes column must stay plaintext (reported, not sealed)",
    );
  } finally {
    clearEncryptedColumnRegistry();
  }
});

// Compile-time pins for the column mapping.
const typed = s.privateTable("typedvault", {
  body: s.string(),
  workspaceId: s.ref("workspaces"),
  title: s.plain(s.string()),
});
clearEncryptedColumnRegistry();
const typedApp = s.defineApp({ workspaces: s.table({ name: s.string() }), typedvault: typed });
clearEncryptedColumnRegistry();

Deno.test("privateTable type mapping: sealed columns lose where, plain and refs keep it", () => {
  // Plain-marked and ref columns remain filterable.
  const byTitle = typedApp.typedvault.where({ title: "x" });
  const byRef = typedApp.typedvault.where({ workspaceId: "some-id" });
  assert(byTitle !== undefined && byRef !== undefined, "plaintext filters must stay expressible");
  // @ts-expect-error — a sealed column is excluded from where
  typedApp.typedvault.where({ body: "x" });
});
