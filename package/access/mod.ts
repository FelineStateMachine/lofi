/** Narrow private/direct-share/group access templates over raw Jazz schemas. */
export { AccessError, type AccessErrorCode, isAccessError } from "./errors.ts";
export {
  decodeSharingIdentity,
  encodeSharingIdentity,
  type SharingIdentity,
  sharingIdentity,
} from "./identity.ts";
export {
  createGroupOperations,
  createSharingOperations,
  type GroupMembershipRow,
  type GroupOperations,
  type SharedGrantRow,
  type ShareLevel,
  type SharingOperations,
} from "./operations.ts";
export {
  type AccessTemplate,
  defineAccessPolicies,
  groupAccess,
  type GroupAccessTemplate,
  privateAccess,
  type PrivateAccessTemplate,
  type RawAccessPolicyExtension,
  sharedAccess,
  type SharedAccessTemplate,
} from "./policies.ts";
export {
  groupMembershipTable,
  type GroupRole,
  groupRoleCapabilities,
  groupRoles,
  sharedGrantTable,
} from "./schema.ts";
