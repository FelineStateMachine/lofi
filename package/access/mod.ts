/**
 * Narrow private, direct-share, and fixed-role group access templates over raw
 * Jazz schemas.
 *
 * Use {@link privateAccess}, {@link sharedAccess}, or {@link groupAccess} to
 * declare common authorization models. Runtime operations require managed sync
 * for collaboration and throw {@link AccessError} when that precondition is not
 * met. Raw Jazz policy callbacks remain available through
 * {@link defineAccessPolicies}.
 *
 * @module
 */
export { AccessError, type AccessErrorCode, isAccessError } from "./errors.ts";
export {
  decodeSharingIdentity,
  encodeSharingIdentity,
  type SharingIdentity,
  sharingIdentity,
} from "./identity.ts";
export {
  type AccessRuntimeTable,
  createGroupOperations,
  createSharingOperations,
  type GroupMembershipRow,
  type GroupOperations,
  type Identified,
  type SharedGrantRow,
  type ShareLevel,
  type SharingOperations,
} from "./operations.ts";
export {
  type AccessTable,
  type AccessTemplate,
  defineAccessPolicies,
  groupAccess,
  type GroupAccessTemplate,
  privateAccess,
  type PrivateAccessTemplate,
  type RawAccessPolicyContext,
  type RawAccessPolicyExtension,
  type RuleBuilder,
  sharedAccess,
  type SharedAccessTemplate,
  type TablePolicy,
} from "./policies.ts";
export {
  groupMembershipTable,
  type GroupRole,
  groupRoleCapabilities,
  groupRoles,
  sharedGrantTable,
} from "./schema.ts";
