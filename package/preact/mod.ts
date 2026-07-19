/**
 * Optional Preact bindings for the lofi runtime: live typed queries
 * ({@link useLiveQuery}), table mutations ({@link useTableMutations}), the
 * per-write sync lifecycle ({@link useWrite}, {@link usePendingWrites},
 * {@link useSyncStatus}), first-load progress ({@link useBootProgress}), and
 * the schema-compatibility gate
 * ({@link useSchemaCompat}), plus package-owned example components
 * ({@link DeviceStatus}, {@link PwaActions}, {@link RuntimeRecovery},
 * {@link TicketEnrollForm}) that application layouts may compose or replace
 * with UI built on the same public runtime APIs.
 *
 * @module
 */
export { default as DeviceStatus } from "./DeviceStatus.tsx";
export { RuntimeRecovery, type RuntimeRecoveryProps } from "./RuntimeRecovery.tsx";
export {
  type LiveQuerySnapshot,
  type TableMutations,
  type TableMutationSnapshot,
  useLiveQuery,
  useTableMutations,
} from "./live-data.ts";
export {
  PwaActions,
  type PwaActionsProps,
  type PwaController,
  type PwaFailureCode,
  pwaFailureMessage,
  type PwaState,
  type PwaUpdateState,
  usePwaState,
} from "./PwaActions.tsx";
export { TicketEnrollForm, type TicketEnrollFormProps } from "./TicketEnrollForm.tsx";
export { usePendingWrites, useSyncStatus, useWrite, type WriteState } from "./write-hooks.ts";
export type { WriteHandle, WriteRejection, WriteStage } from "../runtime/write-handle.ts";
export type {
  PendingWritesSnapshot,
  PendingWriteSummary,
  RowSyncStatus,
} from "../runtime/write-ledger.ts";
export {
  type SchemaCompatReason,
  type SchemaCompatState,
  useSchemaCompat,
} from "./use-schema-compat.ts";
export { type BootProgress, type BootProgressPhase, useBootProgress } from "./use-boot-progress.ts";
export {
  type DeviceCapabilitiesHook,
  type DeviceCapabilityReport,
  useDeviceCapabilities,
} from "./use-device-capabilities.ts";
