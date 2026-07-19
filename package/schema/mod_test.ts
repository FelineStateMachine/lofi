import { schema } from "jazz-tools";
import {
  clearEncryptedColumnRegistry,
  defineNestedApp,
  defineNestedPermissions,
  flattenNestedSchema,
  isEncryptedColumn,
  mergeNestedPermissions,
  s,
} from "./mod.ts";

// The facade re-exports, never reimplements: every curated member must be the
// pinned Jazz 2 original by identity, so semantics cannot drift. The define
// entry points are the one narrowing of that rule: they delegate to the
// originals unchanged but first record encrypted columns into the registry,
// so they are asserted as wrappers below rather than as identities here.
const curatedMembers = [
  "string",
  "boolean",
  "int",
  "float",
  "timestamp",
  "bytes",
  "json",
  "enum",
  "ref",
  "array",
  "add",
  "drop",
  "renameFrom",
  "table",
  "defineMigration",
  "renameTableFrom",
  "definePermissions",
  "permissionIntrospectionColumns",
] as const;

const wrappedDefineMembers = ["defineSchema", "defineApp", "defineSliceableApp"] as const;

Deno.test("schema facade exposes every curated member as the Jazz original", () => {
  for (const member of curatedMembers) {
    if (!(member in schema)) {
      throw new Error(`jazz-tools schema namespace no longer provides "${member}"`);
    }
    if (s[member] !== (schema as Record<string, unknown>)[member]) {
      throw new Error(`facade member "${member}" is not the jazz-tools original`);
    }
  }
});

Deno.test("the define entry points delegate to Jazz and feed the encrypted registry", () => {
  for (const member of wrappedDefineMembers) {
    if (!(member in schema)) {
      throw new Error(`jazz-tools schema namespace no longer provides "${member}"`);
    }
    if (s[member] === (schema as Record<string, unknown>)[member]) {
      throw new Error(
        `facade member "${member}" lost its registration wrapper — encrypted columns ` +
          "would no longer register",
      );
    }
  }
  clearEncryptedColumnRegistry();
  try {
    // Delegation is observable: defineSchema returns its definition unchanged
    // (the pinned original's contract) while registering the sealed column.
    const definition = {
      diary: s.table({
        title: s.string(),
        body: s.encryptedText("modtest.diary.body"),
      }),
    };
    const defined: unknown = s.defineSchema(definition as never);
    if (defined !== definition) {
      throw new Error("defineSchema no longer returns the definition unchanged");
    }
    if (!isEncryptedColumn("diary", "body")) {
      throw new Error("defineSchema did not register the encrypted column");
    }
  } finally {
    clearEncryptedColumnRegistry();
  }
});

// The nested-namespace members are the one deliberate exception to the
// re-export rule: they are lofi-owned (a naming layer over the pinned
// defineSliceableApp), so they must be lofi's functions, not Jazz members.
Deno.test("the nested-namespace members are the lofi-owned originals", () => {
  const lofiMembers = {
    defineNestedApp,
    defineNestedPermissions,
    mergeNestedPermissions,
    flattenNestedSchema,
  } as const;
  for (const [name, member] of Object.entries(lofiMembers)) {
    if (s[name as keyof typeof lofiMembers] !== member) {
      throw new Error(`facade member "${name}" is not the lofi nested-namespace original`);
    }
    if (name in schema) {
      throw new Error(
        `jazz-tools now provides "${name}" — resolve the collision with the lofi member`,
      );
    }
  }
});

Deno.test("a schema declared through the facade round-trips app and permissions", () => {
  const app = s.defineApp({
    tasks: s.table({
      text: s.string(),
      completed: s.boolean(),
      createdAt: s.timestamp(),
    }),
  });
  if (typeof app.tasks?.where !== "function") {
    throw new Error("facade-declared app does not expose a queryable table");
  }
  const permissions = s.definePermissions(app, ({ policy }) => {
    policy.tasks.allowInsert.always();
  });
  if (!permissions || typeof permissions !== "object") {
    throw new Error("facade-declared permissions did not compile");
  }
});
