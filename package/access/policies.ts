import { schema as s } from "jazz-tools";
import type { CompiledPermissions } from "jazz-tools";
import { AccessError } from "./errors.ts";

type AccessTable = {
  readonly _table: string;
  readonly _schema: Record<string, { columns?: unknown[] }>;
};

export type PrivateAccessTemplate = { readonly kind: "private"; readonly resource: AccessTable };
export type SharedAccessTemplate = {
  readonly kind: "shared";
  readonly resource: AccessTable;
  readonly grants: AccessTable;
};
export type GroupAccessTemplate = {
  readonly kind: "group";
  readonly groups: AccessTable;
  readonly members: AccessTable;
  readonly resources: readonly AccessTable[];
  readonly groupId: string;
};
export type AccessTemplate = PrivateAccessTemplate | SharedAccessTemplate | GroupAccessTemplate;

export function privateAccess(config: { resource: AccessTable }): PrivateAccessTemplate {
  return { kind: "private", ...config };
}

export function sharedAccess(config: {
  resource: AccessTable;
  grants: AccessTable;
}): SharedAccessTemplate {
  return { kind: "shared", ...config };
}

export function groupAccess(config: {
  groups: AccessTable;
  members: AccessTable;
  resources: AccessTable | readonly AccessTable[];
  groupId: string;
}): GroupAccessTemplate {
  return {
    kind: "group",
    groups: config.groups,
    members: config.members,
    resources: Array.isArray(config.resources) ? config.resources : [config.resources],
    groupId: config.groupId,
  };
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
  }
}

type RuleBuilder = {
  where(input: unknown): unknown;
  always(): unknown;
};
type TablePolicy = {
  allowRead: RuleBuilder;
  allowInsert: RuleBuilder;
  allowUpdate: RuleBuilder;
  allowDelete: RuleBuilder;
  exists: { where(input: unknown): unknown };
};
type RawAccessPolicyContext = {
  policy: Record<string, TablePolicy>;
  session: { user_id: unknown };
  anyOf(conditions: readonly unknown[]): unknown;
  allOf(conditions: readonly unknown[]): unknown;
  allowedTo: {
    update(fkColumn: string): unknown;
  };
};

export type RawAccessPolicyExtension = (context: RawAccessPolicyContext) => void;

/**
 * Compiles the three narrow templates through Jazz's own policy builder. The
 * optional callback is the raw Jazz-policy escape hatch for app-specific rules.
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
    const { policy, session, anyOf, allOf, allowedTo } =
      jazzContext as unknown as RawAccessPolicyContext;
    for (const template of templates) {
      if (template.kind === "private") {
        const resource = policy[template.resource._table];
        resource.allowInsert.always();
        resource.allowRead.where({ $createdBy: session.user_id });
        resource.allowUpdate.where({ $createdBy: session.user_id });
        resource.allowDelete.where({ $createdBy: session.user_id });
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
      groups.allowRead.where((group: Record<string, unknown>) =>
        anyOf([isMember(group.id), { $createdBy: session.user_id }])
      );
      groups.allowInsert.always();
      groups.allowUpdate.where((group: Record<string, unknown>) =>
        anyOf([{ $createdBy: session.user_id }, isAdmin(group.id)])
      );
      groups.allowDelete.where((group: Record<string, unknown>) => isAdmin(group.id));
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
    }
    raw?.({ policy, session, anyOf, allOf, allowedTo });
  });
}
