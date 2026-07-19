import { schema as s } from "jazz-tools";
import type { CompiledPermissions } from "jazz-tools";
import { isEncryptedColumn } from "../schema/encrypted.ts";
import { AccessError } from "./errors.ts";

/** Minimum declared Jazz table metadata consumed by access templates. */
export type AccessTable = {
  readonly _table: string;
  readonly _schema: Record<string, { columns?: unknown[] }>;
};

/** Owner-only resource policy template. */
export type PrivateAccessTemplate = { readonly kind: "private"; readonly resource: AccessTable };
/** Direct-share resource and grant-table policy template. */
export type SharedAccessTemplate = {
  readonly kind: "shared";
  readonly resource: AccessTable;
  readonly grants: AccessTable;
};
/** Fixed-role group, membership, and resource policy template. */
export type GroupAccessTemplate = {
  readonly kind: "group";
  readonly groups: AccessTable;
  readonly members: AccessTable;
  readonly resources: readonly AccessTable[];
  readonly groupId: string;
  /** The group's wrapped-field-key table, when it hosts shared columns. */
  readonly fieldKeys?: AccessTable;
};
/** Shared-field key-directory policy template. */
export type SharedFieldAccessTemplate = {
  readonly kind: "shared-field";
  readonly directory: AccessTable;
};
/** Any built-in access policy template accepted by {@link defineAccessPolicies}. */
export type AccessTemplate =
  | PrivateAccessTemplate
  | SharedAccessTemplate
  | GroupAccessTemplate
  | SharedFieldAccessTemplate;

/**
 * Declares owner-only read and mutation policy for one resource table.
 *
 * @example
 * ```ts
 * import { defineAccessPolicies, privateAccess } from "@nzip/lofi/access";
 * import { app } from "./schema.ts";
 *
 * export default defineAccessPolicies(app, [privateAccess({ resource: app.notes })]);
 * ```
 *
 * @param config The resource table whose rows are visible and mutable only to their creator.
 * @returns A template for {@link defineAccessPolicies}.
 */
export function privateAccess(config: { resource: AccessTable }): PrivateAccessTemplate {
  return { kind: "private", ...config };
}

/**
 * Declares owner plus explicit read/edit grants for one resource table.
 *
 * The grant table must be declared with the `sharedGrantTable` helper (or match
 * its column shape) and reference the resource table.
 *
 * @example
 * ```ts
 * import { defineAccessPolicies, sharedAccess } from "@nzip/lofi/access";
 * import { app } from "./schema.ts";
 *
 * export default defineAccessPolicies(app, [
 *   sharedAccess({ resource: app.notes, grants: app.noteGrants }),
 * ]);
 * ```
 *
 * @param config The shared resource table and its grant table.
 * @returns A template for {@link defineAccessPolicies}.
 */
export function sharedAccess(config: {
  resource: AccessTable;
  grants: AccessTable;
}): SharedAccessTemplate {
  return { kind: "shared", ...config };
}

/**
 * Declares fixed-role membership policy for one or more group-owned resources.
 *
 * The membership table must be declared with the `groupMembershipTable` helper
 * (or match its column shape), and each resource table must carry the `groupId`
 * column referencing the group table.
 *
 * Group-creator authority is permanent: the creator can always update their
 * group row, and through it restore their own admin membership even after
 * being demoted or removed. Choose this template only when that trust
 * property fits — a group cannot durably expel its creator.
 *
 * @example
 * ```ts
 * import { defineAccessPolicies, groupAccess } from "@nzip/lofi/access";
 * import { app } from "./schema.ts";
 *
 * export default defineAccessPolicies(app, [groupAccess({
 *   groups: app.workspaces,
 *   members: app.workspaceMembers,
 *   resources: app.documents,
 *   groupId: "workspaceId",
 * })]);
 * ```
 *
 * @param config The group table, membership table, group-owned resource table(s), and the
 * resource column that references the group.
 * @returns A template for {@link defineAccessPolicies}.
 */
export function groupAccess(config: {
  groups: AccessTable;
  members: AccessTable;
  resources: AccessTable | readonly AccessTable[];
  groupId: string;
  /** Wrapped-field-key table for groups hosting shared encrypted columns
   * (declared with `sharedFieldKeyTable`). Readable by each row's recipient
   * or any member; inserted by a member signing as themselves; updated only
   * by the row's sender; deleted by the sender, the recipient, or a group
   * admin. */
  fieldKeys?: AccessTable;
}): GroupAccessTemplate {
  return {
    kind: "group",
    groups: config.groups,
    members: config.members,
    resources: Array.isArray(config.resources) ? config.resources : [config.resources],
    groupId: config.groupId,
    ...(config.fieldKeys ? { fieldKeys: config.fieldKeys } : {}),
  };
}

/**
 * Declares the shared-field key directory policy: every authenticated
 * account reads the directory (public keys are public — integrity comes from
 * fingerprint pinning), and each account writes only its own row, so the
 * store cannot be used to impersonate a publisher through the policy layer.
 *
 * The directory table must be declared with the `sharedFieldDirectoryTable`
 * helper (or match its column shape).
 *
 * @param config The key directory table.
 * @returns A template for {@link defineAccessPolicies}.
 */
export function sharedFieldAccess(config: { directory: AccessTable }): SharedFieldAccessTemplate {
  return { kind: "shared-field", ...config };
}

type Column = {
  name?: string;
  references?: string;
  column_type?: { type?: string; variants?: string[] };
};

function columns(table: AccessTable): Column[] {
  const definition = table._schema[table._table];
  return (definition?.columns ?? []) as Column[];
}

function requireColumn(
  table: AccessTable,
  name: string,
  type: string,
  references?: string,
): Column {
  if (isEncryptedColumn(table._table, name)) {
    throw new AccessError(
      "configuration",
      `Access table ${table._table} declares ${name} as an encrypted column; template columns ` +
        "are evaluated by the server, which cannot read ciphertext. Use a plaintext column.",
    );
  }
  const column = columns(table).find((candidate) => candidate.name === name);
  if (!column || column.column_type?.type !== type || column.references !== references) {
    const reference = references ? ` referencing ${references}` : "";
    throw new AccessError(
      "configuration",
      `Access table ${table._table} must contain ${name} as ${type}${reference}. Use the matching @nzip/lofi/access table helper or correct the raw Jazz schema.`,
    );
  }
  return column;
}

function validateTemplate(template: AccessTemplate): void {
  if (template.kind === "shared") {
    requireColumn(template.grants, "resourceId", "Uuid", template.resource._table);
    requireColumn(template.grants, "user_id", "Text");
    requireColumn(template.grants, "can_edit", "Boolean");
  }
  if (template.kind === "shared-field") {
    requireColumn(template.directory, "user_id", "Text");
    requireColumn(template.directory, "algo", "Text");
    requireColumn(template.directory, "public_key", "Text");
    requireColumn(template.directory, "fingerprint", "Text");
  }
  if (template.kind === "group") {
    requireColumn(template.members, "groupId", "Uuid", template.groups._table);
    requireColumn(template.members, "user_id", "Text");
    requireColumn(template.members, "role", "Text");
    requireColumn(template.members, "can_create", "Boolean");
    requireColumn(template.members, "can_edit_any", "Boolean");
    requireColumn(template.members, "can_manage", "Boolean");
    for (const resource of template.resources) {
      requireColumn(resource, template.groupId, "Uuid", template.groups._table);
    }
    if (template.fieldKeys) {
      requireColumn(template.fieldKeys, "groupId", "Uuid", template.groups._table);
      requireColumn(template.fieldKeys, "recipient_user_id", "Text");
      requireColumn(template.fieldKeys, "sender_user_id", "Text");
      requireColumn(template.fieldKeys, "generation", "Integer");
      requireColumn(template.fieldKeys, "wrapped_key", "Text");
      requireColumn(template.fieldKeys, "recipient_fingerprint", "Text");
      requireColumn(template.fieldKeys, "sender_fingerprint", "Text");
    }
  }
}

/** Minimal Jazz rule builder exposed to raw access-policy extensions. */
export type RuleBuilder = {
  where(input: unknown): unknown;
  always(): unknown;
};
/** Read and mutation policy builders for one declared table. */
export type TablePolicy = {
  allowRead: RuleBuilder;
  allowInsert: RuleBuilder;
  allowUpdate: RuleBuilder;
  allowDelete: RuleBuilder;
  exists: { where(input: unknown): unknown };
};
/** Raw Jazz policy-builder context exposed to advanced policy extensions. */
export type RawAccessPolicyContext = {
  policy: Record<string, TablePolicy>;
  session: { user_id: unknown };
  anyOf(conditions: readonly unknown[]): unknown;
  allOf(conditions: readonly unknown[]): unknown;
  allowedTo: {
    update(fkColumn: string): unknown;
  };
};

/** Callback for app-specific rules that do not fit the built-in templates. */
export type RawAccessPolicyExtension = (context: RawAccessPolicyContext) => void;

// A policy referencing an encrypted column would compile but silently never
// match — the server compares ciphertext it cannot read — so every rule
// builder refuses such conditions at compile time. Object conditions are
// checked directly; function conditions have their returned condition checked
// against the same table, and any condition they build for another table
// passes through that table's own guarded builder.
function assertNoEncryptedConditionKeys(tableName: string, input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  for (const key of Object.keys(input)) {
    if (key.startsWith("$")) continue;
    if (isEncryptedColumn(tableName, key)) {
      throw new AccessError(
        "configuration",
        `Policy for ${tableName} filters on encrypted column ${key}; the server cannot ` +
          "evaluate what it cannot read. Gate on a plaintext column instead.",
      );
    }
  }
}

function guardedWhere(
  tableName: string,
  rule: { where(input: unknown): unknown },
): (input: unknown) => unknown {
  return (input: unknown) => {
    if (typeof input === "function") {
      return rule.where((row: unknown) => {
        const condition = (input as (row: unknown) => unknown)(row);
        assertNoEncryptedConditionKeys(tableName, condition);
        return condition;
      });
    }
    assertNoEncryptedConditionKeys(tableName, input);
    return rule.where(input);
  };
}

function guardTablePolicy(tableName: string, tablePolicy: TablePolicy): TablePolicy {
  const guardRule = (rule: RuleBuilder): RuleBuilder => ({
    where: guardedWhere(tableName, rule),
    always: () => rule.always(),
  });
  return {
    allowRead: guardRule(tablePolicy.allowRead),
    allowInsert: guardRule(tablePolicy.allowInsert),
    allowUpdate: guardRule(tablePolicy.allowUpdate),
    allowDelete: guardRule(tablePolicy.allowDelete),
    exists: { where: guardedWhere(tableName, tablePolicy.exists) },
  };
}

function guardPolicies(policy: Record<string, TablePolicy>): Record<string, TablePolicy> {
  return new Proxy(policy, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "object" || value === null) {
        return value;
      }
      return guardTablePolicy(property, value as TablePolicy);
    },
  });
}

/**
 * Compiles the four narrow templates through Jazz's own policy builder. The
 * optional callback is the raw Jazz-policy escape hatch for app-specific rules.
 *
 * @example
 * ```ts
 * import { defineAccessPolicies, groupAccess, sharedAccess } from "@nzip/lofi/access";
 * import { app } from "./schema.ts";
 *
 * export default defineAccessPolicies(app, [
 *   sharedAccess({ resource: app.notes, grants: app.noteGrants }),
 *   groupAccess({
 *     groups: app.workspaces,
 *     members: app.workspaceMembers,
 *     resources: app.documents,
 *     groupId: "workspaceId",
 *   }),
 * ]);
 * ```
 *
 * @param app The raw Jazz app returned by `s.defineApp`.
 * @param templates At least one {@link privateAccess}, {@link sharedAccess},
 * {@link groupAccess}, or {@link sharedFieldAccess} template; every table needs
 * a policy. `sharedFieldAccess` compiles the key directory behind shared
 * encrypted columns; pair it with the `fieldKeys` option of
 * {@link groupAccess}, and group operations created with the same tables run
 * the key lifecycle (bootstrap on creation, wrap delivery, lazy rotation, and
 * `reconcileSharedFieldKeys` repair).
 * @param raw Optional raw-policy callback for app-specific rules beyond the templates.
 * @returns Compiled permissions suitable as the app's default policy export.
 */
export function defineAccessPolicies<TApp extends object>(
  app: TApp,
  templates: readonly AccessTemplate[],
  raw?: RawAccessPolicyExtension,
): CompiledPermissions {
  if (templates.length === 0) {
    throw new AccessError("configuration", "defineAccessPolicies requires at least one template.");
  }
  for (const template of templates) validateTemplate(template);

  return s.definePermissions(app, (jazzContext) => {
    const rawContext = jazzContext as unknown as RawAccessPolicyContext;
    const guarded: RawAccessPolicyContext = {
      ...rawContext,
      policy: guardPolicies(rawContext.policy),
    };
    const { policy, session, anyOf, allOf, allowedTo } = guarded;
    for (const template of templates) {
      if (template.kind === "private") {
        const resource = policy[template.resource._table];
        resource.allowInsert.always();
        resource.allowRead.where({ $createdBy: session.user_id });
        resource.allowUpdate.where({ $createdBy: session.user_id });
        resource.allowDelete.where({ $createdBy: session.user_id });
        continue;
      }
      if (template.kind === "shared-field") {
        const directory = policy[template.directory._table];
        directory.allowRead.always();
        directory.allowInsert.where({ user_id: session.user_id });
        directory.allowUpdate.where({ user_id: session.user_id });
        directory.allowDelete.where({ user_id: session.user_id });
        continue;
      }
      if (template.kind === "shared") {
        const resource = policy[template.resource._table];
        const grants = policy[template.grants._table];
        const ownerOf = (resourceId: unknown) =>
          resource.exists.where({ id: resourceId, $createdBy: session.user_id });
        resource.allowInsert.always();
        resource.allowRead.where((row: Record<string, unknown>) =>
          anyOf([
            { $createdBy: session.user_id },
            grants.exists.where({ resourceId: row.id, user_id: session.user_id }),
          ])
        );
        resource.allowUpdate.where((row: Record<string, unknown>) =>
          anyOf([
            { $createdBy: session.user_id },
            grants.exists.where({
              resourceId: row.id,
              user_id: session.user_id,
              can_edit: true,
            }),
          ])
        );
        resource.allowDelete.where({ $createdBy: session.user_id });
        grants.allowRead.where((grant: Record<string, unknown>) =>
          anyOf([{ user_id: session.user_id }, ownerOf(grant.resourceId)])
        );
        grants.allowInsert.where((grant: Record<string, unknown>) => ownerOf(grant.resourceId));
        grants.allowUpdate.where((grant: Record<string, unknown>) => ownerOf(grant.resourceId));
        grants.allowDelete.where((grant: Record<string, unknown>) => ownerOf(grant.resourceId));
        continue;
      }

      const groups = policy[template.groups._table];
      const members = policy[template.members._table];
      const isMember = (groupId: unknown) =>
        members.exists.where({ groupId, user_id: session.user_id });
      const hasCapability = (groupId: unknown, capability: string) =>
        members.exists.where({ groupId, user_id: session.user_id, [capability]: true });
      const isAdmin = (groupId: unknown) => hasCapability(groupId, "can_manage");
      // Group-creator authority is PERMANENT by design: the creator can always
      // update the group row, and — because membership management derives from
      // group-update via `allowedTo.update` — can always restore their own
      // admin membership after demotion or removal. This is a documented trust
      // property of the template, not an oversight: scoping creator authority
      // to a bootstrap window ("only while no admin membership exists")
      // requires a negated existence condition, and the pinned Jazz alpha.53
      // policy engine silently drops Not around Exists/ExistsRel — the window
      // cannot be enforced at the policy boundary. The engine canary in
      // access_security_test.ts fails when an upgrade fixes negation; implement
      // the window then. See docs/decisions/group-creator-authority-alpha53.md.
      //
      // Direct creator delete below grants no additional authority (a creator
      // can always self-bootstrap an admin membership and delete transitively);
      // it exists so group creation can roll back when the first admin insert
      // fails, instead of stranding an undeletable orphan row.
      groups.allowRead.where((group: Record<string, unknown>) =>
        anyOf([isMember(group.id), { $createdBy: session.user_id }])
      );
      groups.allowInsert.always();
      groups.allowUpdate.where((group: Record<string, unknown>) =>
        anyOf([{ $createdBy: session.user_id }, isAdmin(group.id)])
      );
      groups.allowDelete.where((group: Record<string, unknown>) =>
        anyOf([{ $createdBy: session.user_id }, isAdmin(group.id)])
      );
      members.allowRead.where(
        anyOf([
          { user_id: session.user_id },
          allowedTo.update("groupId"),
        ]),
      );
      members.allowInsert.where(allowedTo.update("groupId"));
      members.allowUpdate.where(allowedTo.update("groupId"));
      members.allowDelete.where(
        anyOf([allowedTo.update("groupId"), { user_id: session.user_id }]),
      );
      for (const table of template.resources) {
        const resource = policy[table._table];
        resource.allowRead.where((row: Record<string, unknown>) => isMember(row[template.groupId]));
        resource.allowInsert.where((row: Record<string, unknown>) =>
          hasCapability(row[template.groupId], "can_create")
        );
        resource.allowUpdate.where((row: Record<string, unknown>) =>
          anyOf([
            hasCapability(row[template.groupId], "can_edit_any"),
            allOf([
              { $createdBy: session.user_id },
              hasCapability(row[template.groupId], "can_create"),
            ]),
          ])
        );
        resource.allowDelete.where((row: Record<string, unknown>) =>
          anyOf([
            hasCapability(row[template.groupId], "can_edit_any"),
            allOf([
              { $createdBy: session.user_id },
              hasCapability(row[template.groupId], "can_create"),
            ]),
          ])
        );
      }
      if (template.fieldKeys) {
        // Wrapped field keys: recipients and members read (members see who
        // holds keys, which key repair needs); any member may wrap but only
        // as themselves — a malicious member is already inside the crypto
        // boundary, so restricting senders to admins buys nothing and hurts
        // availability. Recipients may shed their own wraps; admins clean up.
        const fieldKeys = policy[template.fieldKeys._table];
        fieldKeys.allowRead.where((row: Record<string, unknown>) =>
          anyOf([{ recipient_user_id: session.user_id }, isMember(row.groupId)])
        );
        fieldKeys.allowInsert.where((row: Record<string, unknown>) =>
          allOf([{ sender_user_id: session.user_id }, isMember(row.groupId)])
        );
        fieldKeys.allowUpdate.where({ sender_user_id: session.user_id });
        fieldKeys.allowDelete.where((row: Record<string, unknown>) =>
          anyOf([
            { sender_user_id: session.user_id },
            { recipient_user_id: session.user_id },
            isAdmin(row.groupId),
          ])
        );
      }
    }
    raw?.({ policy, session, anyOf, allOf, allowedTo });
  });
}
