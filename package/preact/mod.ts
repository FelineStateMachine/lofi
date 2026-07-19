/**
 * Optional Preact bindings for the lofi runtime: live typed queries
 * ({@link useLiveQuery}), table mutations ({@link useTableMutations}), the
 * per-write sync lifecycle ({@link useWrite}, {@link usePendingWrites},
 * {@link useSyncStatus}), first-load progress ({@link useBootProgress}),
 * PWA install/update state ({@link usePwaState}), device capabilities
 * ({@link useDeviceCapabilities}), the schema-compatibility gate
 * ({@link useSchemaCompat}), and the storage-container fork guard
 * ({@link useStorageFork}), plus package-owned example components
 * ({@link DeviceStatus}, {@link PwaActions}, {@link RuntimeRecovery},
 * {@link TicketEnrollForm}) that application layouts may compose or replace
 * with UI built on the same public runtime APIs.
 *
 * @module
 */
export { DeviceStatus } from "./DeviceStatus.tsx";
export { RuntimeRecovery, type RuntimeRecoveryProps } from "./RuntimeRecovery.tsx";
export {
  type LiveQuerySnapshot,
  type TableMutations,
  type TableMutationSnapshot,
  useLiveQuery,
  useTableMutations,
} from "./live-data.ts";
export type { TableRow } from "../runtime/table-store.ts";
export {
  PwaActions,
  type PwaActionsProps,
  type PwaController,
  type PwaFailureCode,
  pwaFailureMessage,
  type PwaInstallState,
  type PwaState,
  type PwaUpdateState,
  type PwaWorkerState,
  usePwaState,
} from "./PwaActions.tsx";
export { TicketEnrollForm, type TicketEnrollFormProps } from "./TicketEnrollForm.tsx";
export type { SealOutcome } from "../runtime/provision.ts";
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
export {
  type StorageForkState,
  type StorageForkSurface,
  useStorageFork,
} from "./use-storage-fork.ts";
export type { StorageForkGuard } from "../runtime/storage-fork.ts";
export { type BootProgress, type BootProgressPhase, useBootProgress } from "./use-boot-progress.ts";
export {
  type DeviceCapabilitiesState,
  type DeviceCapabilityReport,
  useDeviceCapabilities,
} from "./use-device-capabilities.ts";
export type { Session, SessionSink } from "../runtime/session.ts";
export type {
  RuntimeStartupFailure,
  RuntimeStartupFailureCode,
} from "../runtime/startup-recovery.ts";
