/**
 * Nested app namespaces over one Jazz store.
 *
 * `defineNestedApp` groups tables into app-level namespaces
 * (`taskapp.tasks`, `notesapp.notes`) while compiling a single runtime
 * schema underneath — one hash, one migration lineage, one query planner.
 * Namespacing is a lofi-owned naming layer: each nested table flattens to a
 * global table name with a reserved separator, `defineSliceableApp` compiles
 * the flat schema once, and every namespace receives typed handles under its
 * unprefixed local names.
 *
 * @module
 */
import {
  type App,
  type CompiledPermissions,
  type PolicyContext,
  type Schema,
  schema,
  type SchemaDefinition,
} from "jazz-tools";
import { registerEncryptedColumns } from "./encrypted.ts";

/**
 * The reserved separator between a namespace and a table in the flattened
 * global table name. It is deliberately not `.`: the permission builder
 * reserves `${string}.${string}` keys for qualified-column `where` entries.
 * Namespace and table names must not contain it.
 */
export const NESTED_SEPARATOR = "__";

/** A nested schema definition: namespaces mapping to per-namespace tables. */
export type NestedSchemaDefinition = Record<string, SchemaDefinition>;

/**
 * The value returned by {@link defineNestedApp}: one typed app per namespace,
 * each exposing that namespace's tables under their unprefixed local names.
 */
export type NestedApp<TDef extends NestedSchemaDefinition> = {
  [NS in keyof TDef & string]: App<Schema<TDef[NS]>>;
};

const nestedAppMetaKey = Symbol.for("@nzip/lofi/nested-app");
const namespaceMetaKey = Symbol.for("@nzip/lofi/nested-namespace");

type NamespaceMeta = {
  namespace: string;
  /** The mangled-key slice app: `definePermissions` keys rules by app object keys. */
  permissionTarget: object;
  /** Pairs of [local table name, mangled global table name]. */
  tableNames: ReadonlyArray<readonly [string, string]>;
};

type NestedAppMeta = {
  /** Every namespace's table handles, flattened — the runtime table registry. */
  tables: readonly object[];
  /** A slice over every table, keyed by mangled global names, for deploy tooling. */
  deployTarget: object;
};

function assertNamePart(kind: "namespace" | "table", name: string): void {
  if (!name.trim()) throw new Error(`nested app ${kind} name must not be empty`);
  if (name.includes(".")) {
    throw new Error(`nested app ${kind} name "${name}" must not contain "."`);
  }
  if (name.includes(NESTED_SEPARATOR)) {
    throw new Error(
      `nested app ${kind} name "${name}" must not contain the reserved separator "${NESTED_SEPARATOR}"`,
    );
  }
}

function mangle(namespace: string, table: string): string {
  return `${namespace}${NESTED_SEPARATOR}${table}`;
}

type ColumnBuilderLike = {
  _references?: string;
  _targetTable?: string;
  _element?: ColumnBuilderLike;
};

type TableSourceLike = {
  __jazzTableDefinition?: boolean;
  columns?: Record<string, ColumnBuilderLike>;
  indexedColumns?: readonly string[];
};

function tableColumns(source: unknown): Record<string, ColumnBuilderLike> {
  const like = source as TableSourceLike;
  if (like && typeof like === "object" && like.__jazzTableDefinition === true && like.columns) {
    return like.columns;
  }
  return source as Record<string, ColumnBuilderLike>;
}

// Rebuilds a column builder with its ref target renamed, preserving the
// builder's prototype so `_build` and the `_references` getter keep working.
// Builders are cloned, never mutated: the author's definition objects stay
// reusable.
function cloneWithTarget(builder: ColumnBuilderLike, target: string): ColumnBuilderLike {
  const clone = Object.create(
    Object.getPrototypeOf(builder),
    Object.getOwnPropertyDescriptors(builder),
  ) as ColumnBuilderLike;
  if (Object.hasOwn(builder, "_targetTable")) {
    clone._targetTable = target;
    return clone;
  }
  if (builder._element && builder._element._references !== undefined) {
    clone._element = cloneWithTarget(builder._element, target);
    return clone;
  }
  throw new Error(
    `nested app ref column has an unrecognized builder shape; ` +
      `cannot rewrite its target "${builder._references}"`,
  );
}

function resolveRefTarget(
  definition: NestedSchemaDefinition,
  namespace: string,
  column: string,
  target: string,
): string {
  if (target.includes(NESTED_SEPARATOR)) {
    throw new Error(
      `ref target "${target}" (${namespace}, column "${column}") must use namespace names, ` +
        `not the reserved separator "${NESTED_SEPARATOR}"`,
    );
  }
  if (target.includes(".")) {
    const [otherNamespace, otherTable, ...rest] = target.split(".");
    if (rest.length > 0 || !definition[otherNamespace]?.[otherTable]) {
      throw new Error(
        `ref target "${target}" (${namespace}, column "${column}") does not name a ` +
          `declared "<namespace>.<table>"`,
      );
    }
    return mangle(otherNamespace, otherTable);
  }
  if (definition[namespace]?.[target]) return mangle(namespace, target);
  throw new Error(
    `ref target "${target}" (${namespace}, column "${column}") is not a table in this ` +
      `namespace; reference another namespace as "<namespace>.<table>"`,
  );
}

function rewriteTableRefs(
  definition: NestedSchemaDefinition,
  namespace: string,
  source: unknown,
): unknown {
  const columns = tableColumns(source);
  const rewritten: Record<string, ColumnBuilderLike> = {};
  let changed = false;
  for (const [name, builder] of Object.entries(columns)) {
    const target = builder?._references;
    if (typeof target === "string") {
      rewritten[name] = cloneWithTarget(
        builder,
        resolveRefTarget(definition, namespace, name, target),
      );
      changed = true;
    } else {
      rewritten[name] = builder;
    }
  }
  if (!changed) return source;
  const like = source as TableSourceLike;
  return like.__jazzTableDefinition === true
    ? {
      __jazzTableDefinition: true,
      columns: rewritten,
      ...(like.indexedColumns ? { indexedColumns: like.indexedColumns } : {}),
    }
    : rewritten;
}

/**
 * Flattens a nested schema definition into the single global table namespace
 * that actually compiles and deploys: `taskapp.tasks` becomes
 * `taskapp__tasks`. Ref targets written against namespace-local names (or as
 * `"<namespace>.<table>"` across namespaces) are rewritten to the mangled
 * global names. Use the flattened definitions as the `from`/`to` schemas when
 * authoring migrations over a nested app; moving a table between namespaces
 * is then an ordinary `renameTableFrom` migration.
 */
export function flattenNestedSchema(definition: NestedSchemaDefinition): SchemaDefinition {
  const flat: Record<string, unknown> = {};
  const namespaces = Object.entries(definition);
  if (namespaces.length === 0) throw new Error("nested app must declare at least one namespace");
  for (const [namespace, tables] of namespaces) {
    assertNamePart("namespace", namespace);
    const names = Object.keys(tables);
    if (names.length === 0) {
      throw new Error(`nested app namespace "${namespace}" must declare at least one table`);
    }
    for (const name of names) {
      assertNamePart("table", name);
      flat[mangle(namespace, name)] = rewriteTableRefs(definition, namespace, tables[name]);
    }
  }
  return flat as SchemaDefinition;
}

/**
 * Declares nested app namespaces over one compiled schema. Each namespace's
 * tables become ordinary typed table handles under their unprefixed names:
 *
 * ```ts
 * export const root = s.defineNestedApp({
 *   taskapp: {
 *     tasks: s.table({ text: s.string(), completed: s.boolean() }),
 *   },
 *   notesapp: {
 *     notes: s.table({ title: s.string() }),
 *   },
 * });
 * // root.taskapp.tasks and root.notesapp.notes are ordinary table handles.
 * ```
 *
 * Handles are constructed exactly once, here — the runtime keys table stores
 * by handle identity, so this is the only expressible construction shape and
 * duplicate subscriptions cannot arise. Declare permissions per namespace
 * with {@link defineNestedPermissions} and combine the compiled bundles with
 * {@link mergeNestedPermissions}.
 *
 * Known constraint (alpha.53): every table is a runtime sibling of every
 * namespace, so the g-set isolation guidance cannot be satisfied inside one
 * store — keep g-set columns out of nested apps until the upstream
 * destabilization pin clears (see the conformance findings in
 * docs/decisions/schema-facade-alpha53.md).
 */
export function defineNestedApp<const TDef extends NestedSchemaDefinition>(
  definition: TDef,
): NestedApp<TDef> {
  const flat = flattenNestedSchema(definition);
  registerEncryptedColumns(flat);
  const sliceable = schema.defineSliceableApp(flat as never);
  const root: Record<string, unknown> = {};
  const allTables: object[] = [];
  for (const [namespace, tables] of Object.entries(definition)) {
    const locals = Object.keys(tables);
    const mangled = locals.map((name) => mangle(namespace, name));
    const slice = sliceable.slice(
      ...(mangled as [string, ...string[]]),
    ) as unknown as Record<string, unknown>;
    const namespaceApp: Record<string, unknown> = {};
    for (let index = 0; index < locals.length; index++) {
      const handle = slice[mangled[index]] as object;
      namespaceApp[locals[index]] = handle;
      allTables.push(handle);
    }
    namespaceApp.union = slice.union;
    namespaceApp.wasmSchema = sliceable.wasmSchema;
    Object.defineProperty(namespaceApp, namespaceMetaKey, {
      value: {
        namespace,
        permissionTarget: slice,
        tableNames: locals.map((local, index) => [local, mangled[index]] as const),
      } satisfies NamespaceMeta,
    });
    root[namespace] = namespaceApp;
  }
  Object.defineProperty(root, nestedAppMetaKey, {
    value: {
      tables: allTables,
      deployTarget: sliceable.slice(
        ...(Object.keys(flat) as unknown as [string, ...string[]]),
      ),
    } satisfies NestedAppMeta,
  });
  return root as NestedApp<TDef>;
}

/**
 * Declares permissions for one namespace of a nested app. The policy context
 * exposes only that namespace's tables, under their unprefixed local names;
 * the compiled output is a flat record keyed by the mangled global table
 * names, so per-namespace bundles merge collision-free into the one deployed
 * bundle:
 *
 * ```ts
 * export const taskPermissions = s.defineNestedPermissions(
 *   root.taskapp,
 *   ({ policy }) => {
 *     policy.tasks.allowRead.always();
 *   },
 * );
 * ```
 *
 * Use this — not `s.definePermissions` — for nested namespaces: the pinned
 * `definePermissions` keys compiled rules by the app object's property
 * names, so calling it on a namespace directly would compile unprefixed
 * table names that the deployed schema does not contain.
 */
export function defineNestedPermissions<TApp extends object>(
  namespace: TApp,
  factory: (ctx: PolicyContext<TApp>) => void,
): CompiledPermissions {
  const meta = (namespace as { [namespaceMetaKey]?: NamespaceMeta })[namespaceMetaKey];
  if (!meta) {
    throw new Error(
      "defineNestedPermissions requires a namespace value from defineNestedApp",
    );
  }
  return schema.definePermissions(meta.permissionTarget as never, (ctx) => {
    const mangledPolicy = ctx.policy as unknown as Record<string, unknown>;
    const policy: Record<string, unknown> = {
      exists: mangledPolicy.exists,
      union: mangledPolicy.union,
    };
    for (const [local, mangled] of meta.tableNames) policy[local] = mangledPolicy[mangled];
    factory({ ...ctx, policy } as unknown as PolicyContext<TApp>);
  });
}

/**
 * Combines per-namespace compiled permission bundles into the one bundle a
 * nested app deploys. Namespaced table names cannot collide by construction;
 * a duplicate key means the same namespace was compiled twice and throws.
 */
export function mergeNestedPermissions(
  ...bundles: readonly CompiledPermissions[]
): CompiledPermissions {
  const merged: CompiledPermissions = {};
  for (const bundle of bundles) {
    for (const [table, policies] of Object.entries(bundle)) {
      if (table in merged) {
        throw new Error(`merged permissions declare table "${table}" more than once`);
      }
      merged[table] = policies;
    }
  }
  return merged;
}

/**
 * The flattened table-handle registry of a nested app, or `null` when the
 * value is not a nested app root. The runtime consumes this so nested tables
 * participate in boot readiness and local-to-managed row migration; the
 * handles are the same objects the namespaces expose, so store identity is
 * preserved.
 */
export function nestedAppTables(app: unknown): readonly object[] | null {
  if (!app || typeof app !== "object") return null;
  const meta = (app as { [nestedAppMetaKey]?: NestedAppMeta })[nestedAppMetaKey];
  return meta?.tables ?? null;
}

/**
 * An app-like value over every table of a nested app, keyed by the mangled
 * global table names — the shape schema deploy tooling and the policy test
 * harness expect. Throws when the value is not a nested app root.
 */
export function nestedAppDeployTarget(app: unknown): object {
  const meta = app && typeof app === "object"
    ? (app as { [nestedAppMetaKey]?: NestedAppMeta })[nestedAppMetaKey]
    : undefined;
  if (!meta) throw new Error("nestedAppDeployTarget requires a root value from defineNestedApp");
  return meta.deployTarget;
}
