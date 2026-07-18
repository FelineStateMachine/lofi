// The nested-namespace naming layer, exercised without an engine: name
// mangling, definition validation, ref-target rewriting, the flattened
// runtime registry, and the per-namespace permissions surface. Engine
// round-trips live in ./nested_conformance_test.ts.
import { assert } from "../runtime/test-assert.ts";
import {
  flattenNestedSchema,
  NESTED_SEPARATOR,
  nestedAppDeployTarget,
  nestedAppTables,
  s,
} from "./mod.ts";

function throws(operation: () => unknown, fragment: string, label: string): void {
  try {
    operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes(fragment),
      `${label}: threw "${message}", expected it to mention "${fragment}"`,
    );
    return;
  }
  throw new Error(`${label}: expected a throw mentioning "${fragment}"`);
}

function tableName(handle: unknown): string {
  return (handle as { _table: string })._table;
}

const root = s.defineNestedApp({
  taskapp: {
    projects: s.table({ name: s.string() }),
    tasks: s.table({ projectId: s.ref("projects"), text: s.string() }),
  },
  notesapp: {
    notes: s.table({ title: s.string() }),
  },
});

Deno.test("defineNestedApp flattens to mangled global names behind unprefixed handles", () => {
  assert(
    tableName(root.taskapp.tasks) === `taskapp${NESTED_SEPARATOR}tasks`,
    `tasks handle targets ${tableName(root.taskapp.tasks)}`,
  );
  assert(
    tableName(root.notesapp.notes) === `notesapp${NESTED_SEPARATOR}notes`,
    `notes handle targets ${tableName(root.notesapp.notes)}`,
  );
  assert(
    typeof (root.taskapp.tasks as { where?: unknown }).where === "function",
    "namespace handles are not queryable",
  );
  assert(
    !("taskapp__tasks" in root.taskapp),
    "mangled names leaked into the namespace object",
  );
});

Deno.test("nested table handles are constructed once and shared with the registry", () => {
  const registry = nestedAppTables(root);
  assert(registry !== null, "nested root exposes no table registry");
  assert(registry.length === 3, `registry holds ${registry.length} handles, expected 3`);
  for (const handle of [root.taskapp.projects, root.taskapp.tasks, root.notesapp.notes]) {
    assert(
      registry.includes(handle as object),
      `registry is missing the ${tableName(handle)} handle by identity`,
    );
  }
});

Deno.test("nestedAppTables returns null for flat apps so the runtime keeps its one-level walk", () => {
  const flat = s.defineApp({ tasks: s.table({ text: s.string() }) });
  assert(nestedAppTables(flat) === null, "flat app misdetected as nested");
  assert(nestedAppTables(undefined) === null, "undefined misdetected as nested");
});

Deno.test("the deploy target exposes every table under its mangled global name", () => {
  const target = nestedAppDeployTarget(root) as Record<string, unknown>;
  for (const name of ["taskapp__projects", "taskapp__tasks", "notesapp__notes"]) {
    assert(name in target, `deploy target is missing "${name}"`);
  }
  assert("wasmSchema" in target, "deploy target is missing wasmSchema");
  throws(
    () => nestedAppDeployTarget(root.taskapp),
    "requires a root value",
    "deploy target on a namespace",
  );
});

Deno.test("nested definitions reject names that break the mangling scheme", () => {
  const table = s.table({ name: s.string() });
  throws(
    () => flattenNestedSchema({ ["bad__ns"]: { items: table } }),
    "reserved separator",
    "separator in namespace",
  );
  throws(
    () => flattenNestedSchema({ ns: { ["bad__table"]: table } }),
    "reserved separator",
    "separator in table",
  );
  throws(
    () => flattenNestedSchema({ ["bad.ns"]: { items: table } }),
    `must not contain "."`,
    "dot in namespace",
  );
  throws(() => flattenNestedSchema({}), "at least one namespace", "empty definition");
  throws(() => flattenNestedSchema({ ns: {} }), "at least one table", "empty namespace");
});

Deno.test("ref targets resolve within the namespace or as <namespace>.<table> across namespaces", () => {
  const flat = flattenNestedSchema({
    taskapp: {
      projects: s.table({ name: s.string() }),
      tasks: s.table({ projectId: s.ref("projects") }),
    },
    notesapp: {
      notes: s.table({ taskId: s.ref("taskapp.tasks").optional() }),
    },
  }) as Record<string, { columns: Record<string, { _references?: string }> }>;
  assert(
    flat.taskapp__tasks.columns.projectId._references === "taskapp__projects",
    `same-namespace ref rewrote to ${flat.taskapp__tasks.columns.projectId._references}`,
  );
  assert(
    flat.notesapp__notes.columns.taskId._references === "taskapp__tasks",
    `cross-namespace ref rewrote to ${flat.notesapp__notes.columns.taskId._references}`,
  );

  throws(
    () =>
      flattenNestedSchema({
        ns: { items: s.table({ ownerId: s.ref("missing") }) },
      }),
    "is not a table in this namespace",
    "unknown bare ref target",
  );
  throws(
    () =>
      flattenNestedSchema({
        ns: { items: s.table({ ownerId: s.ref("other.missing") }) },
      }),
    "does not name a declared",
    "unknown qualified ref target",
  );
  throws(
    () =>
      flattenNestedSchema({
        ns: { items: s.table({ ownerId: s.ref("ns__items") }) },
      }),
    "reserved separator",
    "mangled ref target",
  );
});

Deno.test("ref rewriting clones builders instead of mutating the author's definition", () => {
  const projectRef = s.ref("projects");
  flattenNestedSchema({
    taskapp: {
      projects: s.table({ name: s.string() }),
      tasks: s.table({ projectId: projectRef }),
    },
  });
  assert(
    (projectRef as unknown as { _references?: string })._references === "projects",
    "flattening mutated the shared ref builder",
  );
});

Deno.test("defineNestedPermissions exposes unprefixed policy names and compiles mangled keys", () => {
  let observedPolicyKeys: string[] = [];
  const compiled = s.defineNestedPermissions(root.taskapp, ({ policy }) => {
    observedPolicyKeys = Object.keys(policy);
    policy.tasks.allowRead.always();
    policy.tasks.allowInsert.always();
    policy.projects.allowRead.always();
  });
  assert(
    observedPolicyKeys.includes("tasks") && observedPolicyKeys.includes("projects"),
    `policy context exposes ${observedPolicyKeys.join(", ")}`,
  );
  assert(
    !observedPolicyKeys.includes("notes") && !observedPolicyKeys.includes("taskapp__tasks"),
    "policy context leaked other namespaces or mangled names",
  );
  const compiledKeys = Object.keys(compiled).sort();
  assert(
    compiledKeys.join(",") === "taskapp__projects,taskapp__tasks",
    `compiled bundle keyed by ${compiledKeys.join(", ")}`,
  );
});

Deno.test("defineNestedPermissions rejects values that are not nested namespaces", () => {
  const flat = s.defineApp({ tasks: s.table({ text: s.string() }) });
  throws(
    () => s.defineNestedPermissions(flat, () => {}),
    "requires a namespace value",
    "flat app as namespace",
  );
});

Deno.test("per-namespace permission bundles merge collision-free; duplicates throw", () => {
  const taskBundle = s.defineNestedPermissions(root.taskapp, ({ policy }) => {
    policy.tasks.allowRead.always();
  });
  const noteBundle = s.defineNestedPermissions(root.notesapp, ({ policy }) => {
    policy.notes.allowRead.always();
  });
  const merged = s.mergeNestedPermissions(taskBundle, noteBundle);
  const keys = Object.keys(merged).sort();
  assert(
    keys.join(",") === "notesapp__notes,taskapp__tasks",
    `merged bundle keyed by ${keys.join(", ")}`,
  );
  throws(
    () => s.mergeNestedPermissions(taskBundle, taskBundle),
    "more than once",
    "duplicate bundle merge",
  );
});
