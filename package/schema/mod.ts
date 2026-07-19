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
import { effect, insert, log, mutation, remove, update } from "./effects.ts";
import { encryptedJson, encryptedText } from "./encrypted.ts";
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
    encryptedText: typeof encryptedText;
    encryptedJson: typeof encryptedJson;
    mutation: typeof mutation;
    effect: typeof effect;
    log: typeof log;
    insert: typeof insert;
    update: typeof update;
    remove: typeof remove;
  };

/**
 * The lofi schema surface. Use in `src/schema.ts` and `src/permissions.ts` in
 * place of a raw `jazz-tools` import; Jazz member names and behavior are
 * identical to the pinned Jazz 2 DSL. The lofi-owned members: nested
 * namespaces ({@link defineNestedApp}), sealed columns ({@link encryptedText},
 * {@link encryptedJson}), and the verb grammar — {@link mutation} declares
 * callable verbs over {@link insert}, {@link update}, and {@link remove},
 * carrying {@link effect} units and {@link log} entries. Verb calls return a
 * `WriteHandle`, observed in UI through `useWrite` and `usePendingWrites`
 * from `@nzip/lofi/preact`.
 */
export const s: SchemaDsl = {
  ...schema,
  defineNestedApp,
  defineNestedPermissions,
  mergeNestedPermissions,
  flattenNestedSchema,
  encryptedText,
  encryptedJson,
  mutation,
  effect,
  log,
  insert,
  update,
  remove,
};

export {
  clearEncryptedColumnKey,
  EncryptedColumnError,
  encryptedJson,
  encryptedText,
  setEncryptedColumnKey,
} from "./encrypted.ts";
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
export {
  clearEffectDeclarations,
  effect,
  type EffectContext,
  type EffectHandlers,
  type EffectRow,
  type EffectUnit,
  insert,
  type InsertVerb,
  log,
  mutation,
  type MutationDescriptor,
  type MutationOp,
  type MutationOpKind,
  type MutationOptions,
  type MutationRuntime,
  type MutationVerb,
  remove,
  type RemoveVerb,
  resolveEffectUnit,
  setMutationRuntime,
  update,
  type UpdateVerb,
} from "./effects.ts";

// Store provisioning (./store.ts) is deliberately NOT re-exported here: the
// Jazz schema loader bundles the author's schema module graph — this facade
// included — and executes it to derive the deployed schema, so this module
// must stay authoring-only. Import provisioning from "@nzip/lofi/schema/store".

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
