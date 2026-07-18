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

/**
 * The curated schema DSL type: every member is the pinned Jazz 2 original,
 * unchanged. Deprecated members (`rename`) and surface lofi does not yet
 * exercise (`defineSliceableApp`) are omitted; everything else re-exports
 * one-to-one.
 */
export type SchemaDsl = Pick<
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
  // Schema migrations.
  | "defineMigration"
  | "renameTableFrom"
  // Permissions.
  | "definePermissions"
  | "permissionIntrospectionColumns"
>;

/**
 * The lofi schema surface. Use in `src/schema.ts` and `src/permissions.ts` in
 * place of a raw `jazz-tools` import; member names and behavior are identical
 * to the pinned Jazz 2 DSL.
 */
export const s: SchemaDsl = schema;

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
 * workaround below: calling `.merge()` on a column loses the typed builder
 * (the untyped `merge(): this` signature shadows the typed overload
 * upstream), so cast the result back to the intended column type. The
 * runtime object is unchanged; only the declaration needs repair:
 *
 * ```ts
 * total: s.int().default(0).merge("counter") as unknown as IntColumn<false, true>,
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
