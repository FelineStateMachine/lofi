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
 * @module
 */

export { defineLofiApp, type LofiAppConfig, LofiConfigurationError } from "./app.ts";
export {
  type AuthCapability,
  type AuthDependencies,
  authenticateAndDerivePrfSecret,
  authenticateDeviceCredential,
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
  sealProvisionCapability,
  unlockProvisionCapability,
} from "./provision.ts";
export {
  assertDurableBrowser,
  type DeviceCapabilityReport,
  type DurableCapabilityReport,
  durableCapabilityReport,
  DurableStorageUnsupportedError,
  readDeviceCapabilityReport,
  requestPersistentStorage,
} from "./device-capabilities.ts";
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
export { type RuntimeDiagnostics } from "./diagnostics.ts";
export {
  describeSchemaCompat,
  getSchemaCompatState,
  SchemaCompatibilityError,
  type SchemaCompatReason,
  type SchemaCompatState,
  subscribeSchemaCompat,
} from "./schema-compat.ts";
export {
  createStorageForkGuard,
  describeStorageFork,
  dismissStorageFork,
  getStorageForkState,
  type StorageForkGuard,
  storageForkGuard,
  type StorageForkGuardDependencies,
  type StorageForkState,
  subscribeStorageFork,
} from "./storage-fork.ts";
export {
  acquireLiveQuery,
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
  reloadAfterRuntimeStartupFailure,
  RuntimeStartupError,
  type RuntimeStartupFailure,
  type RuntimeStartupFailureCode,
} from "./startup-recovery.ts";
export { describeStoreStatus, type RuntimeStoreStatus } from "./store-status.ts";
export {
  acquireTableMutations,
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
  type PasskeyBackupReceipt,
  readAccountSession,
  readSession,
  restoreFromPasskey,
  restoreFromRecoveryPhrase,
  revealRecoveryPhrase,
  type Session,
  type SessionSink,
  stopSyncBackup,
} from "./session.ts";
export {
  clearDeclaredSink,
  type DataSinkDeclaration,
  DataSinkError,
  declareDataSink,
  isDataSinkError,
  parseSyncTicket,
  readDeclaredSink,
  restoreDeclaredSink,
  type SinkRestoreOutcome,
  splitTicketForEnrollment,
  type SyncTicket,
  type TicketSplit,
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
} from "./table-store.ts";
export { settleUiMutation } from "./ui-mutation.ts";
export { classifyMutationError, type MutationErrorClass } from "./mutation-taxonomy.ts";
export {
  WriteHandle,
  WriteRejectedError,
  type WriteRejection,
  type WriteStage,
} from "./write-handle.ts";
export {
  armWriteLedger,
  getWriteLedger,
  type LedgerWriteOptions,
  type LedgerWriteRequest,
  type PendingWritesSnapshot,
  type PendingWriteSummary,
  type RowSyncStatus,
  WriteLedger,
  type WriteLedgerEnvironment,
} from "./write-ledger.ts";
export {
  createDefaultJournalStorage,
  createMemoryJournalStorage,
  type JournalDocument,
  type JournalEffectState,
  journalIdFor,
  type JournalStorage,
  type JournalWriteRecord,
  type JournalWriteStage,
} from "./write-journal.ts";
export type { EffectLogEntry } from "./diagnostics.ts";
export {
  clearFingerprintPins,
  deriveSharedFieldIdentity,
  type DirectoryPublication,
  directoryPublicKey,
  ensureDirectoryEntry,
  installSharedFieldIdentityFromSecret,
  pinnedFingerprint,
  trustPeerKey,
  verifyAndPinFingerprint,
} from "./shared-field-keys.ts";
export {
  completePopExchange,
  type DevicePublicKey,
  exportDevicePublicKey,
  getOrCreatePopKeyPair,
  memoryPopKeyStore,
  type PopKeyStore,
  popMessage,
  signPopMessage,
} from "./pop.ts";
