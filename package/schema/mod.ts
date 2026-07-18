/**
 * Declare application tables, permissions, and migrations without importing
 * Jazz directly.
 *
 * This module is a curated re-export of the pinned Jazz 2 schema DSL: the
 * same names and semantics, narrowed to the surface lofi documents and tests.
 * Author code imports {@link s} from here instead of `jazz-tools`, so version
 * bumps and upstream renames are absorbed by the package rather than by every
 * application schema.
 *
 * ```ts
 * import { s } from "@nzip/lofi/schema";
 *
 * export const app = s.defineApp({
 *   tasks: s.table({
 *     text: s.string(),
 *     completed: s.boolean(),
 *     createdAt: s.timestamp(),
 *   }),
 * });
 * ```
 *
 * @module
 */
import { schema } from "jazz-tools";
import {
  defineNestedApp,
  defineNestedPermissions,
  flattenNestedSchema,
  mergeNestedPermissions,
} from "./nested.ts";

/**
 * The curated schema DSL type. Every Jazz member is the pinned Jazz 2
 * original, unchanged; deprecated members (`rename`) are omitted, and
 * everything else re-exports one-to-one. The nested-namespace members
 * (`defineNestedApp`, `defineNestedPermissions`, `mergeNestedPermissions`,
 * `flattenNestedSchema`) are lofi-owned: a naming layer over the pinned
 * `defineSliceableApp`, not part of the Jazz DSL.
 */
export type SchemaDsl =
  & Pick<
    typeof schema,
    // Column constructors.
    | "string"
    | "boolean"
    | "int"
    | "float"
    | "timestamp"
    | "bytes"
    | "json"
    | "enum"
    | "ref"
    | "array"
    // Column migration operations.
    | "add"
    | "drop"
    | "renameFrom"
    // Tables, schemas, and apps.
    | "table"
    | "defineSchema"
    | "defineApp"
    | "defineSliceableApp"
    // Schema migrations.
    | "defineMigration"
    | "renameTableFrom"
    // Permissions.
    | "definePermissions"
    | "permissionIntrospectionColumns"
  >
  & {
    defineNestedApp: typeof defineNestedApp;
    defineNestedPermissions: typeof defineNestedPermissions;
    mergeNestedPermissions: typeof mergeNestedPermissions;
    flattenNestedSchema: typeof flattenNestedSchema;
  };

/**
 * The lofi schema surface. Use in `src/schema.ts` and `src/permissions.ts` in
 * place of a raw `jazz-tools` import; Jazz member names and behavior are
 * identical to the pinned Jazz 2 DSL, and the nested-namespace members are
 * the lofi naming layer documented on {@link defineNestedApp}.
 */
export const s: SchemaDsl = {
  ...schema,
  defineNestedApp,
  defineNestedPermissions,
  mergeNestedPermissions,
  flattenNestedSchema,
};

export {
  defineNestedApp,
  defineNestedPermissions,
  flattenNestedSchema,
  mergeNestedPermissions,
  NESTED_SEPARATOR,
  type NestedApp,
  nestedAppDeployTarget,
  nestedAppTables,
  type NestedSchemaDefinition,
} from "./nested.ts";

/**
 * Schema-authoring types re-exported from the pinned Jazz 2 DSL for use in
 * application signatures. Row types for UI code come from `@nzip/lofi`
 * (`RowOf`), not from this module.
 */
export type {
  App,
  DefinedTable,
  InsertOf,
  Schema,
  SchemaDefinition,
  TableDefinition,
  WhereOf,
} from "jazz-tools";

/**
 * Column builder types re-exported for signatures and for the alpha.53
 * workaround below: calling `.merge()` or `.transform()` on a column loses
 * the typed builder (the legacy untyped signatures shadow the typed
 * overloads upstream), so cast the result back to the intended column type.
 * The runtime object is unchanged; only the declaration needs repair:
 *
 * ```ts
 * total: s.int().default(0).merge("counter") as unknown as IntColumn<false, true>,
 * tags: s.string().transform({
 *   from: (value: string) => value.split(","),
 *   to: (value: string[]) => value.join(","),
 * }) as unknown as StringColumn<false, false, string[]>,
 * ```
 */
export type {
  ArrayColumn,
  BooleanColumn,
  BytesColumn,
  EnumColumn,
  FloatColumn,
  IntColumn,
  JsonColumn,
  RefColumn,
  StringColumn,
  TimestampColumn,
} from "jazz-tools";
