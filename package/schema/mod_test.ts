import { schema } from "jazz-tools";
import { s } from "./mod.ts";

// The facade re-exports, never reimplements: every curated member must be the
// pinned Jazz 2 original by identity, so semantics cannot drift.
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
  "defineSchema",
  "defineApp",
  "defineMigration",
  "renameTableFrom",
  "definePermissions",
  "permissionIntrospectionColumns",
] as const;

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
