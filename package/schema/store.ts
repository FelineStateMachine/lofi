/**
 * Opt-in store provisioning for nested apps: classify a sync store's deployed
 * schema against this app's slice, and create or update **only this app's
 * namespaces** in it.
 *
 * A user-supplied store is shared infrastructure — another app's tables may
 * already live in it. Provisioning therefore works as a merge over the stored
 * schema: the head schema is fetched verbatim, this app's tables are appended
 * or verified, every other table (and its policies) is preserved byte-for-byte,
 * and the change deploys as an ordinary migration advancing the store's one
 * permissions head. The safety invariant is enforced here, before anything is
 * published: an app may only create tables under its own declared namespaces,
 * and any generated change naming a table outside them is a hard error.
 *
 * Every operation needs store administration — supplying the admin secret,
 * or holding a provision-scoped app-connect ticket whose gate injects it, is
 * the user's opt-in. Nothing in the normal sync path calls this module; the
 * one exception is {@link readTicketStoreStatus}, the metadata-only preflight
 * any valid ticket may call.
 *
 * @module
 */
import type { CompiledPermissions } from "jazz-tools";
import {
  NESTED_SEPARATOR,
  nestedAppDeployTarget,
  type NestedAppRoot,
  nestedAppTables,
} from "./nested.ts";

export type { NestedAppRoot } from "./nested.ts";

/** The store to provision: where it is, which app it hosts, and the admin opt-in. */
export type StoreTarget = {
  /** The http(s) sync server URL (a ticket URL keeps its secret base path). */
  serverUrl: string;
  /** The Jazz app id of the store. */
  appId: string;
  /**
   * The store's admin secret — administration rides on top of transport
   * access. Omit it when `serverUrl` is a provision-scoped app-connect
   * ticket URL: the node's gate injects its own admin secret for such
   * requests (and strips any inbound one), so the secret never transits the
   * client.
   */
  adminSecret?: string;
};

/**
 * How a store's deployed schema relates to this app's slice. State literals
 * are snake_case because they relay the sync node's status vocabulary
 * verbatim.
 */
export type StoreStatus =
  /** Nothing is deployed; writes against the store would hang. Remedy: create. */
  | { state: "no_schema" }
  /** The enforced schema carries this app's slice exactly. */
  | { state: "ok"; headHash: string }
  /**
   * The enforced schema lacks some of this app's tables (first enrollment of
   * this app, or a newer app version adding tables). Remedy: update.
   */
  | { state: "schema_out_of_date"; headHash: string; missingTables: readonly string[] }
  /**
   * The store's copy of this app's own namespaces differs from what the app
   * declares in a way its lineage does not explain. Never auto-repaired.
   */
  | { state: "schema_drift"; headHash: string; driftedTables: readonly string[] };

/** The outcome of a provisioning run. */
export type StoreProvisionResult = {
  /** `created` deployed an initial schema; `updated` merged this app's slice. */
  status: "created" | "updated" | "unchanged";
  /** The schema hash now enforcing permissions. */
  headHash: string;
};

/** Raised when provisioning is refused or the store rejects a request. */
export class StoreProvisionError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "StoreProvisionError";
  /**
   * Stable category for provisioning flows. `http` — the store answered a
   * request with a failure or unparseable body. `schema-drift` — the store's
   * copy of this app's namespaces differs from the declaration; surfaced,
   * never auto-repaired. `not-nested` — the supplied app value is not a
   * nested-app root. `outside-namespace` — the permissions bundle names a
   * table outside this app's declared namespaces. `policy-literal` — a policy
   * condition carries a literal value the wire encoding does not support.
   */
  readonly code: "http" | "schema-drift" | "not-nested" | "outside-namespace" | "policy-literal";
  /** Creates a provisioning rejection with a stable category. */
  constructor(
    code: StoreProvisionError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

type WasmColumn = {
  name: string;
  column_type: unknown;
  nullable?: boolean;
  references?: string;
  default?: unknown;
  merge_strategy?: unknown;
};
type WasmTable = { columns: WasmColumn[] };
type WasmSchemaMap = Record<string, WasmTable>;

type PermissionsHead = {
  schemaHash: string;
  version: number;
  parentBundleObjectId: string | null;
  bundleObjectId: string;
};

// ---------------------------------------------------------------------------
// Wire encoding of a freshly compiled permissions bundle.
//
// The store's write endpoints take policy literals as tagged values, but the
// pinned DSL's compiled output carries raw JS values, and the normalization
// that bridges them is not a public jazz-tools export (the module that could
// provide it is not browser-safe). This section mirrors that normalization;
// the store conformance suite deploys through it against the real server, so
// an alpha bump that changes the wire contract fails there loudly. Policies
// read back from the store are already wire-form and are never re-encoded.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeLiteral(value: unknown): unknown {
  if (value === null) return { type: "Null" };
  if (value instanceof Date) return { type: "Timestamp", value: value.getTime() };
  if (value instanceof Uint8Array) {
    throw new StoreProvisionError(
      "policy-literal",
      "bytes literals in policy conditions are not supported by store provisioning",
    );
  }
  if (typeof value === "boolean") return { type: "Boolean", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StoreProvisionError(
        "policy-literal",
        "policy literals only support finite numbers",
      );
    }
    if (!Number.isInteger(value)) return { type: "Double", value };
    if (value >= -2147483648 && value <= 2147483647) return { type: "Integer", value };
    if (Number.isSafeInteger(value)) return { type: "BigInt", value };
    return { type: "Double", value };
  }
  if (typeof value === "string") {
    return UUID_LIKE.test(value) ? { type: "Uuid", value } : { type: "Text", value };
  }
  if (Array.isArray(value)) return { type: "Array", value: value.map(encodeLiteral) };
  if (isRecord(value) && typeof value.type === "string") return value;
  throw new StoreProvisionError(
    "policy-literal",
    "policy literals must be scalars, arrays, Date, or tagged values",
  );
}

function encodePolicyValue(value: unknown): unknown {
  if (isRecord(value) && value.type === "SessionRef") return value;
  const raw = isRecord(value) && "value" in value ? value.value : value;
  return { type: "Literal", value: encodeLiteral(raw) };
}

function encodeRelationValueRef(value: unknown): unknown {
  if (isRecord(value) && "Literal" in value) return { Literal: encodeLiteral(value.Literal) };
  return value;
}

function encodeRelationPredicate(predicate: unknown): unknown {
  if (!isRecord(predicate)) return predicate;
  if ("Cmp" in predicate && isRecord(predicate.Cmp)) {
    return { Cmp: { ...predicate.Cmp, right: encodeRelationValueRef(predicate.Cmp.right) } };
  }
  if ("Contains" in predicate && isRecord(predicate.Contains)) {
    return {
      Contains: { ...predicate.Contains, right: encodeRelationValueRef(predicate.Contains.right) },
    };
  }
  if ("In" in predicate && isRecord(predicate.In)) {
    return {
      In: {
        ...predicate.In,
        values: (predicate.In.values as unknown[]).map(encodeRelationValueRef),
      },
    };
  }
  if ("And" in predicate) {
    return { And: (predicate.And as unknown[]).map(encodeRelationPredicate) };
  }
  if ("Or" in predicate) return { Or: (predicate.Or as unknown[]).map(encodeRelationPredicate) };
  if ("Not" in predicate) return { Not: encodeRelationPredicate(predicate.Not) };
  return predicate;
}

function encodeRelationExpr(expr: unknown): unknown {
  if (!isRecord(expr)) return expr;
  if ("Filter" in expr && isRecord(expr.Filter)) {
    return {
      Filter: {
        input: encodeRelationExpr(expr.Filter.input),
        predicate: encodeRelationPredicate(expr.Filter.predicate),
      },
    };
  }
  if ("Union" in expr && isRecord(expr.Union)) {
    return { Union: { inputs: (expr.Union.inputs as unknown[]).map(encodeRelationExpr) } };
  }
  if ("Join" in expr && isRecord(expr.Join)) {
    return {
      Join: {
        ...expr.Join,
        left: encodeRelationExpr(expr.Join.left),
        right: encodeRelationExpr(expr.Join.right),
      },
    };
  }
  if ("Gather" in expr && isRecord(expr.Gather)) {
    return {
      Gather: {
        ...expr.Gather,
        seed: encodeRelationExpr(expr.Gather.seed),
        step: encodeRelationExpr(expr.Gather.step),
      },
    };
  }
  for (const wrapper of ["Project", "Distinct", "OrderBy", "Offset", "Limit"]) {
    const inner = expr[wrapper];
    if (isRecord(inner)) {
      return { [wrapper]: { ...inner, input: encodeRelationExpr(inner.input) } };
    }
  }
  return expr;
}

function encodePolicyExpr(expr: unknown): unknown {
  if (!isRecord(expr)) return expr;
  switch (expr.type) {
    case "Cmp":
    case "Contains":
      return { ...expr, value: encodePolicyValue(expr.value) };
    case "SessionCmp":
    case "SessionContains":
      return {
        ...expr,
        value: encodeLiteral(isRecord(expr.value) ? expr.value.value : expr.value),
      };
    case "InList":
      return { ...expr, values: (expr.values as unknown[]).map(encodePolicyValue) };
    case "SessionInList":
      return {
        ...expr,
        values: (expr.values as unknown[]).map((value) =>
          encodeLiteral(isRecord(value) ? value.value : value)
        ),
      };
    case "Exists":
      return { ...expr, condition: encodePolicyExpr(expr.condition) };
    case "ExistsRel":
      return { ...expr, rel: encodeRelationExpr(expr.rel) };
    case "And":
    case "Or":
      return { ...expr, exprs: (expr.exprs as unknown[]).map(encodePolicyExpr) };
    case "Not":
      return { ...expr, expr: encodePolicyExpr(expr.expr) };
    default:
      return expr;
  }
}

function encodeOwnPermissions(permissions: CompiledPermissions): Record<string, unknown> {
  const encoded: Record<string, unknown> = {};
  for (const [table, policies] of Object.entries(permissions as Record<string, unknown>)) {
    if (!isRecord(policies)) continue;
    const table_policies: Record<string, unknown> = {};
    for (const operation of ["select", "insert", "update", "delete"]) {
      const policy = policies[operation];
      if (!isRecord(policy)) continue;
      const normalized: Record<string, unknown> = {};
      if (policy.using !== undefined) normalized.using = encodePolicyExpr(policy.using);
      if (policy.with_check !== undefined) {
        normalized.with_check = encodePolicyExpr(policy.with_check);
      }
      table_policies[operation] = normalized;
    }
    encoded[table] = table_policies;
  }
  return encoded;
}

async function adminFetch(
  target: StoreTarget,
  path: string,
  init?: { method: "POST"; body: unknown },
): Promise<unknown> {
  const base = target.serverUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/apps/${target.appId}/${path}`, {
    method: init?.method ?? "GET",
    headers: {
      ...(target.adminSecret ? { "X-Jazz-Admin-Secret": target.adminSecret } : {}),
      ...(init ? { "Content-Type": "application/json" } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new StoreProvisionError(
      "http",
      `store request ${path} failed: HTTP ${response.status} ${text.slice(0, 200)}`,
    );
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new StoreProvisionError("http", `store request ${path} returned non-JSON`);
  }
}

// Structural table comparison in the spirit of the engine's own schema
// equality: column order is irrelevant; every attribute that changes storage
// or merge behavior is significant.
function normalizeColumns(table: WasmTable): string {
  const columns = [...table.columns].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({
    name: c.name,
    column_type: c.column_type,
    nullable: c.nullable === true,
    references: c.references ?? null,
    default: c.default ?? null,
    merge_strategy: c.merge_strategy ?? null,
  }));
  return JSON.stringify(columns);
}

function sameTable(a: WasmTable, b: WasmTable): boolean {
  return normalizeColumns(a) === normalizeColumns(b);
}

function namespaceOf(tableName: string): string | null {
  const index = tableName.indexOf(NESTED_SEPARATOR);
  return index > 0 ? tableName.slice(0, index) : null;
}

type AppSlice = {
  /** This app's tables in wire (wasm) form, keyed by mangled global name. */
  tables: WasmSchemaMap;
  /** This app's declared namespace prefixes. */
  namespaces: ReadonlySet<string>;
};

function appSlice(app: NestedAppRoot): AppSlice {
  if (nestedAppTables(app) === null) {
    throw new StoreProvisionError(
      "not-nested",
      "store provisioning requires a nested app: the namespace is what scopes the changes an " +
        "app may make to a shared store",
    );
  }
  const deployTarget = nestedAppDeployTarget(app) as { wasmSchema: WasmSchemaMap };
  const tables: WasmSchemaMap = {};
  const namespaces = new Set<string>();
  for (const [name, table] of Object.entries(deployTarget.wasmSchema)) {
    tables[name] = table;
    const namespace = namespaceOf(name);
    if (namespace) namespaces.add(namespace);
  }
  return { tables, namespaces };
}

type StoreArtifacts = {
  head: PermissionsHead | null;
  permissions: Record<string, unknown>;
  schema: WasmSchemaMap;
};

async function fetchStore(target: StoreTarget): Promise<StoreArtifacts> {
  const hashes = await adminFetch(target, "schemas") as { hashes?: string[] };
  const bundle = await adminFetch(target, "admin/permissions") as {
    head?: PermissionsHead | null;
    permissions?: Record<string, unknown>;
  };
  const head = bundle.head ?? null;
  if (!head || !hashes.hashes?.length) return { head: null, permissions: {}, schema: {} };
  const stored = await adminFetch(target, `schema/${encodeURIComponent(head.schemaHash)}`) as {
    schema?: WasmSchemaMap;
  };
  return { head, permissions: bundle.permissions ?? {}, schema: stored.schema ?? {} };
}

function classify(slice: AppSlice, artifacts: StoreArtifacts): StoreStatus {
  if (!artifacts.head) return { state: "no_schema" };
  const headHash = artifacts.head.schemaHash;
  const missingTables: string[] = [];
  const driftedTables: string[] = [];
  for (const [name, expected] of Object.entries(slice.tables)) {
    const stored = artifacts.schema[name];
    if (!stored) missingTables.push(name);
    else if (!sameTable(stored, expected)) driftedTables.push(name);
  }
  // A stored table under this app's namespaces that the app does not declare
  // is drift too: either another writer reached into the slug, or the app is
  // older than the store — both need a human, not an auto-merge.
  for (const name of Object.keys(artifacts.schema)) {
    const namespace = namespaceOf(name);
    if (namespace && slice.namespaces.has(namespace) && !(name in slice.tables)) {
      driftedTables.push(name);
    }
  }
  if (driftedTables.length) return { state: "schema_drift", headHash, driftedTables };
  if (missingTables.length) return { state: "schema_out_of_date", headHash, missingTables };
  return { state: "ok", headHash };
}

/**
 * Classifies the store's deployed schema against this app's slice without
 * changing anything. `app` must be a nested-app root from
 * `s.defineNestedApp` — the namespace is what scopes an app's view of a
 * shared store. `no_schema` matters beyond provisioning: against an empty
 * store, client writes hang rather than fail, so callers should reach this
 * state before ever attaching sync to a fresh store.
 */
export async function readStoreStatus(
  app: NestedAppRoot,
  target: StoreTarget,
): Promise<StoreStatus> {
  return classify(appSlice(app), await fetchStore(target));
}

function assertOwnNamespacePermissions(
  slice: AppSlice,
  permissions: CompiledPermissions,
): void {
  for (const table of Object.keys(permissions)) {
    const namespace = namespaceOf(table);
    if (!namespace || !slice.namespaces.has(namespace)) {
      throw new StoreProvisionError(
        "outside-namespace",
        `permissions bundle names table "${table}" outside this app's namespaces ` +
          `(${[...slice.namespaces].join(", ")}) — an app may only provision its own slice`,
      );
    }
  }
}

// A client declares its own compiled schema hash on the wire, and the server
// only serves hashes connected (via migrations) to the head enforcing
// permissions — a disconnected client's writes to its own tables hang. So
// provisioning also registers this app's own-slice schema and, when it is not
// the head itself, publishes the connecting migration (sibling tables as
// `added` lenses). Runs on every provision, so an `unchanged` pass self-heals
// a store whose slice arrived without the edge.
async function ensureSliceConnectivity(
  target: StoreTarget,
  slice: AppSlice,
  headHash: string,
  headSchema: WasmSchemaMap,
): Promise<void> {
  const own = await adminFetch(target, "admin/schemas", {
    method: "POST",
    body: { schema: slice.tables },
  }) as { hash: string };
  if (own.hash === headHash) return;
  const connectivity = await adminFetch(
    target,
    `admin/schema-connectivity?fromHash=${encodeURIComponent(own.hash)}&toHash=${
      encodeURIComponent(headHash)
    }`,
  ) as { connected?: boolean };
  if (connectivity.connected) return;
  const siblingTables = Object.keys(headSchema).filter((name) => !(name in slice.tables));
  await adminFetch(target, "admin/migrations", {
    method: "POST",
    body: {
      fromHash: own.hash,
      toHash: headHash,
      forward: siblingTables.map((table) => ({ table, added: true, operations: [] })),
    },
  });
}

/** What {@link provisionStore} deploys, and where. */
export type ProvisionStoreOptions = {
  /** The nested-app root (from `s.defineNestedApp`) whose slice is provisioned. */
  app: NestedAppRoot;
  /** The app's compiled permissions bundle for its own namespaces. */
  permissions: CompiledPermissions;
  /** The store to provision, with its admin opt-in. */
  target: StoreTarget;
};

/**
 * Creates or updates this app's slice in the store. The stored head schema is
 * fetched verbatim and only extended: missing tables of this app's namespaces
 * are appended (key order of everything else preserved — the schema hash is
 * serialization-sensitive), sibling tables and their policies carry through
 * untouched, and the change publishes as schema + `added`-table migration +
 * a permissions bundle chained to the current head. The app's own compiled
 * schema is additionally registered and connected to the head, so this app's
 * clients — which declare that schema on the wire — are never disconnected.
 * Drift is never repaired: a store whose copy of this app's namespaces
 * differs from the declaration throws with the differing tables.
 */
export async function provisionStore(
  options: ProvisionStoreOptions,
): Promise<StoreProvisionResult> {
  const slice = appSlice(options.app);
  assertOwnNamespacePermissions(slice, options.permissions);
  const artifacts = await fetchStore(options.target);
  const status = classify(slice, artifacts);

  if (status.state === "schema_drift") {
    throw new StoreProvisionError(
      "schema-drift",
      `store tables [${status.driftedTables.join(", ")}] differ from this app's declaration; ` +
        "drift is surfaced, never auto-repaired",
    );
  }
  if (status.state === "ok") {
    await ensureSliceConnectivity(options.target, slice, status.headHash, artifacts.schema);
    return { status: "unchanged", headHash: status.headHash };
  }

  const ownPermissions = encodeOwnPermissions(options.permissions);

  if (status.state === "no_schema") {
    const published = await adminFetch(options.target, "admin/schemas", {
      method: "POST",
      body: { schema: slice.tables },
    }) as { hash: string };
    await adminFetch(options.target, "admin/permissions", {
      method: "POST",
      body: {
        schemaHash: published.hash,
        permissions: ownPermissions,
        expectedParentBundleObjectId: null,
      },
    });
    return { status: "created", headHash: published.hash };
  }

  // schema_out_of_date: append this app's missing tables to the stored schema
  // and swap in this app's policies, leaving every sibling entry untouched.
  const union: WasmSchemaMap = { ...artifacts.schema };
  for (const name of status.missingTables) union[name] = slice.tables[name];
  const unionPermissions: Record<string, unknown> = {};
  for (const [table, policies] of Object.entries(artifacts.permissions)) {
    const namespace = namespaceOf(table);
    if (!(namespace && slice.namespaces.has(namespace))) unionPermissions[table] = policies;
  }
  for (const [table, policies] of Object.entries(ownPermissions)) {
    unionPermissions[table] = policies;
  }

  const head = artifacts.head as PermissionsHead;
  const published = await adminFetch(options.target, "admin/schemas", {
    method: "POST",
    body: { schema: union },
  }) as { hash: string };
  await adminFetch(options.target, "admin/migrations", {
    method: "POST",
    body: {
      fromHash: head.schemaHash,
      toHash: published.hash,
      forward: status.missingTables.map((table) => ({ table, added: true, operations: [] })),
    },
  });
  await adminFetch(options.target, "admin/permissions", {
    method: "POST",
    body: {
      schemaHash: published.hash,
      permissions: unionPermissions,
      expectedParentBundleObjectId: head.bundleObjectId,
    },
  });
  await ensureSliceConnectivity(options.target, slice, published.hash, union);
  return { status: "updated", headHash: published.hash };
}

/**
 * The result of the ticket-scoped store-status preflight. State literals are
 * snake_case because they relay the sync node's status vocabulary verbatim.
 */
export type TicketStoreStatus =
  /** A schema is deployed; `headHash` is the newest stored schema hash. */
  | { state: "deployed"; appId: string; headHash: string }
  /** Nothing is deployed — writes would hang; surface the provisioning opt-in. */
  | { state: "no_schema"; appId: string }
  /** The node is reachable but its store is not (gate answered 502). */
  | { state: "store_unavailable" }
  /** The ticket was revoked or is unknown — treat the stored sink as dead. */
  | { state: "ticket_rejected" }
  /** The endpoint does not exist here (open-mode node or plain Jazz server). */
  | { state: "unsupported" };

/**
 * The metadata-only store preflight any valid app-connect ticket may call —
 * no admin capability required. A self-hosted node answers
 * `GET <ticket.url>/store-status` from its own loopback store, which is what
 * lets a sync-only client learn `no_schema` (where writes hang) before ever
 * attaching sync, and prompt toward the provisioning opt-in instead.
 */
export async function readTicketStoreStatus(ticketUrl: string): Promise<TicketStoreStatus> {
  let response: Response;
  try {
    response = await fetch(`${ticketUrl.replace(/\/+$/, "")}/store-status`);
  } catch {
    return { state: "store_unavailable" };
  }
  if (response.status === 401) {
    await response.body?.cancel();
    return { state: "ticket_rejected" };
  }
  if (response.status === 502) {
    await response.body?.cancel();
    return { state: "store_unavailable" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { state: "unsupported" };
  }
  try {
    const body = await response.json() as {
      v?: number;
      appId?: string;
      schema?: { deployed?: boolean; headHash?: string };
    };
    if (body.v !== 1 || typeof body.appId !== "string" || !body.schema) {
      return { state: "unsupported" };
    }
    return body.schema.deployed && typeof body.schema.headHash === "string"
      ? { state: "deployed", appId: body.appId, headHash: body.schema.headHash }
      : { state: "no_schema", appId: body.appId };
  } catch {
    return { state: "unsupported" };
  }
}
