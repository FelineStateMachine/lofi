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
 * @module
 */

export { defineLofiApp, type LofiAppConfig } from "./app.ts";
export {
  type AuthCapability,
  type AuthDependencies,
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
  type PwaWorkerState,
  requestPwaInstall,
  subscribePwaState,
} from "./pwa.ts";
export { type RuntimeDiagnostics } from "./diagnostics.ts";
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
  AccountReplacementError,
  type AccountReplacementOptions,
  confirmPhraseAccess,
  createBackupPasskey,
  createRecoverablePasskeyBackup,
  enableSyncBackup,
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
  stopSyncBackup,
} from "./session.ts";
export { RecoveryError } from "./recovery.ts";
export { RecoverablePasskeyError, type RecoverablePasskeyErrorCode } from "./passkey-recovery.ts";
export {
  type TableHandle,
  type TableRow,
  type TableSnapshot,
  type TableStore,
  type TableStoreOptions,
} from "./table-store.ts";
export { settleUiMutation } from "./ui-mutation.ts";
