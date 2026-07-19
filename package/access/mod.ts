/**
 * Narrow private, direct-share, fixed-role group, and shared-field access
 * templates over raw Jazz schemas.
 *
 * Use {@link privateAccess}, {@link sharedAccess}, {@link groupAccess}, or
 * {@link sharedFieldAccess} to declare common authorization models. Runtime
 * operations require managed sync for collaboration and throw
 * {@link AccessError} when that precondition is not met. Raw Jazz policy
 * callbacks remain available through {@link defineAccessPolicies}.
 *
 * Group and sharing operations raise two catchable error families:
 * {@link AccessError} (narrow with {@link isAccessError}) for configuration,
 * identity, sync, and mutation failures, and {@link SharedFieldError} (narrow
 * with {@link isSharedFieldError}) when shared-field key material cannot be
 * established or reconciled.
 *
 * Shared-field hosting spans three entries. `@nzip/lofi/schema` declares the
 * encrypted columns (`s.sharedEncryptedText`, `s.sharedEncryptedJson`). This
 * entry compiles the directory and wrapped-key policies and runs the key
 * lifecycle through {@link createGroupOperations}: creation bootstraps the
 * first key and `reconcileSharedFieldKeys` repairs missing wraps. Pin
 * remediation for changed peer keys ({@link trustPeerKey}, with
 * `pinnedFingerprint` for inspection) lives on the main `@nzip/lofi` entry;
 * `trustPeerKey` is re-exported here because re-trusting a peer is an
 * authorization decision.
 *
 * @module
 */
export { AccessError, type AccessErrorCode, isAccessError } from "./errors.ts";
export {
  isSharedFieldError,
  SharedFieldError,
  type SharedFieldErrorCode,
} from "../schema/shared-crypto.ts";
export { trustPeerKey } from "../runtime/shared-field-keys.ts";
export {
  decodeSharingIdentity,
  decodeSharingIdentityDetails,
  encodeSharingIdentity,
  type SharingIdentity,
  sharingIdentity,
  type SharingIdentityDetails,
} from "./identity.ts";
export {
  type AccessRuntimeTable,
  createGroupOperations,
  createSharingOperations,
  type GroupMembershipRow,
  type GroupOperations,
  type GroupOperationsConfig,
  type Identified,
  type SharedGrantRow,
  type ShareLevel,
  type SharingOperations,
  type SharingOperationsConfig,
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
  sharedFieldAccess,
  type SharedFieldAccessTemplate,
  type TablePolicy,
} from "./policies.ts";
export {
  groupMembershipTable,
  type GroupRole,
  groupRoleCapabilities,
  groupRoles,
  sharedFieldDirectoryTable,
  sharedFieldKeyTable,
  sharedGrantTable,
} from "./schema.ts";
