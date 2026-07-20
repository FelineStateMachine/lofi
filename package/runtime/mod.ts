/**
 * Build local-first browser applications with durable storage, reactive tables,
 * optional Jazz sync, recoverable accounts, and an installable PWA lifecycle.
 *
 * Application code composes these APIs; storage, identity, sync, PWA, and
 * lifecycle implementations remain versioned package code.
 *
 * Start with {@link defineLofiApp} and {@link bootLofi}. Use
 * {@link LofiRuntime.store} to bind declared Jazz tables to application UI, and
 * add account backup only after managed sync is configured.
 *
 * Every mutation returns a {@link WriteHandle}: `await` it for local
 * durability (`saved`), observe `synced`/`rejected` for the store's verdict,
 * and read the reload-safe pending set through {@link getWriteLedger} or the
 * `usePendingWrites` hook. Status UI reads {@link RuntimeDiagnostics} (via
 * {@link getRuntimeDiagnostics}), the schema gate through
 * {@link getSchemaCompatState} — `data-ahead` means this device is read-only
 * until {@link applyPwaUpdate} lands a newer bundle — and install/update
 * state through {@link getPwaState}.
 *
 * Shared encrypted fields span three entry points: declaring an encrypted
 * column lives in `@nzip/lofi/schema`, group policy and key lifecycle live in
 * `@nzip/lofi/access`, and pin remediation lives here — a `peer-key-changed`
 * alert in {@link RuntimeDiagnostics.sharedFieldAlerts} is resolved with
 * {@link trustPeerKey} after out-of-band verification.
 *
 * @module
 */

export {
  defineLofiApp,
  isLofiConfigurationError,
  type LofiAppConfig,
  LofiConfigurationError,
} from "./app.ts";
export {
  type AuthCapability,
  type AuthDependencies,
  authenticateAndDerivePrfSecret,
  authenticateDeviceCredential,
  type AuthenticateOptions,
  AuthError,
  classifyCredentialOrigin,
  type CredentialOriginReport,
  decryptAtRest,
  deriveAtRestKey,
  derivePrfSecret,
  type DeviceCredential,
  encryptAtRest,
  enrollDeviceCredential,
  type EnrollOptions,
  getAuthCapability,
  type PrfSupport,
} from "./auth.ts";
export { bootLofi } from "./boot.ts";
export {
  type BootProgress,
  type BootProgressPhase,
  type BootProgressTracker,
  type BootProgressTrackerDependencies,
  createBootProgressTracker,
  type EngineAssetReference,
  getBootProgress,
  subscribeBootProgress,
} from "./boot-progress.ts";
export {
  clearProvisionCapability,
  heldProvisionCapability,
  holdProvisionCapability,
  lockProvisionCapability,
  type ProvisionCapabilityStatus,
  provisionCapabilityStatus,
  type SealOutcome,
  sealProvisionCapability,
  unlockProvisionCapability,
} from "./provision.ts";
export {
  assertDurableBrowser,
  type DeviceCapabilityReport,
  type DurableCapabilityReport,
  durableCapabilityReport,
  DurableStorageUnsupportedError,
  isDurableStorageUnsupportedError,
  readDeviceCapabilityReport,
  requestPersistentStorage,
} from "./device-capabilities.ts";
export { type DeviceKeyStore, EnvelopeError, isEnvelopeError } from "./envelope.ts";
export {
  applyPwaUpdate,
  checkPwaUpdate,
  createPwaController,
  getPwaState,
  type InstallEnvironment,
  type InstallPromptEvent,
  type PwaController,
  pwaController,
  type PwaControllerDependencies,
  type PwaFailureCode,
  pwaFailureMessage,
  type PwaInstallState,
  type PwaState,
  type PwaUpdateState,
  type PwaWorkerState,
  requestPwaInstall,
  subscribePwaState,
} from "./pwa.ts";
export {
  type RuntimeDiagnostics,
  type SharedFieldAlert,
  type SyncOwnerDiagnostic,
} from "./diagnostics.ts";
export {
  createSchemaCompatGate,
  describeSchemaCompat,
  getSchemaCompatState,
  isSchemaCompatibilityError,
  type SchemaCompatGate,
  type SchemaCompatGateDependencies,
  SchemaCompatibilityError,
  type SchemaCompatReason,
  type SchemaCompatState,
  type SchemaCompatUpdateSurface,
  subscribeSchemaCompat,
} from "./schema-compat.ts";
export {
  createStorageForkGuard,
  describeStorageFork,
  dismissStorageFork,
  getStorageForkState,
  type StorageForkDiagnostics,
  type StorageForkDiagnosticsSurface,
  type StorageForkGuard,
  storageForkGuard,
  type StorageForkGuardDependencies,
  type StorageForkState,
  subscribeStorageFork,
} from "./storage-fork.ts";
export {
  acquireLiveQuery,
  type LiveQueryEnvironment,
  type LiveQueryLease,
  type LiveQuerySnapshot,
  type LiveQueryStore,
} from "./live-query-store.ts";
export {
  getRuntime,
  getRuntimeDiagnostics,
  getRuntimePrincipal,
  type LofiRuntime,
  recreateRuntime,
  reloadBrowserRuntime,
  runtimeRecreatedEvent,
  shutdownRuntime,
  subscribeRuntimeDiagnostics,
} from "./runtime.ts";
export {
  isRuntimeStartupError,
  reloadAfterRuntimeStartupFailure,
  RuntimeStartupError,
  type RuntimeStartupFailure,
  type RuntimeStartupFailureCode,
} from "./startup-recovery.ts";
export { describeStoreStatus, type RuntimeStoreStatus } from "./store-status.ts";
export {
  acquireTableMutations,
  type TableMutationEnvironment,
  type TableMutationLease,
  type TableMutationSnapshot,
  type TableMutationStore,
} from "./table-mutations.ts";
export {
  AccountReplacementError,
  type AccountReplacementOptions,
  confirmPhraseAccess,
  createBackupPasskey,
  createRecoverablePasskeyBackup,
  enableSyncBackup,
  enrollSyncTicket,
  type EnrollSyncTicketOptions,
  isAccountReplacementError,
  isAuthError,
  isRecoverablePasskeyError,
  isRecoveryError,
  isSyncEnrollmentError,
  type PasskeyBackupReceipt,
  readAccountSession,
  readSession,
  restoreFromPasskey,
  restoreFromRecoveryPhrase,
  revealRecoveryPhrase,
  type Session,
  type SessionSink,
  stopSyncBackup,
  SyncEnrollmentError,
  type SyncEnrollmentFailureCode,
} from "./session.ts";
export { isSyncOwnerError, SyncOwnerError } from "./sync-owner.ts";
export {
  clearDeclaredSink,
  type DataSinkDeclaration,
  DataSinkError,
  declareDataSink,
  isDataSinkError,
  parseSyncTicket,
  readDeclaredSink,
  readSinkRestoreOutcome,
  restoreDeclaredSink,
  type SinkRestoreOutcome,
  type SyncTicket,
} from "./data-sink.ts";
export { RecoveryError } from "./recovery.ts";
export { RecoverablePasskeyError, type RecoverablePasskeyErrorCode } from "./passkey-recovery.ts";
export {
  type RowOf,
  type TableHandle,
  type TableRow,
  type TableSnapshot,
  type TableStore,
  type TableStoreOptions,
  type WriteDurability,
} from "./table-store.ts";
export { settleUiMutation } from "./ui-mutation.ts";
export { classifyMutationError, type MutationErrorClass } from "./mutation-taxonomy.ts";
export {
  isWriteRejectedError,
  WriteHandle,
  WriteRejectedError,
  type WriteRejection,
  type WriteStage,
} from "./write-handle.ts";
export {
  armWriteLedger,
  dismissAllNotices,
  dismissNotice,
  getNoticeQueue,
  getWriteLedger,
  type LedgerWriteOptions,
  type LedgerWriteRequest,
  listNotices,
  type PendingWritesSnapshot,
  type PendingWriteSummary,
  type ProbeTable,
  type RowSyncStatus,
  subscribeNotices,
  WriteLedger,
  type WriteLedgerEnvironment,
} from "./write-ledger.ts";
export {
  type NoticeEnqueueInput,
  type NoticeEntry,
  NoticeQueue,
  type NoticeTone,
} from "./notice-queue.ts";
export {
  createDefaultJournalStorage,
  createMemoryJournalStorage,
  type JournalDocument,
  type JournalEffectState,
  type JournalEffectStatus,
  journalIdFor,
  type JournalStorage,
  type JournalWriteRecord,
  type JournalWriteStage,
} from "./write-journal.ts";
export type { EffectDebugEvent, EffectLogEntry, EffectTraceEntry } from "./diagnostics.ts";
export { pinnedFingerprint, trustPeerKey, verifyAndPinFingerprint } from "./shared-field-keys.ts";
export type {
  EffectContext,
  EffectHandlers,
  EffectRow,
  EffectUnit,
  MutationDescriptor,
  MutationOp,
  MutationOpKind,
} from "../schema/effects.ts";
