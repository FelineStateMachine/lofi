/**
 * The supported `@nzip/lofi` browser/runtime surface.
 *
 * Application code composes these APIs; storage, identity, sync, PWA, and
 * lifecycle implementations remain versioned package code.
 *
 * @module
 */

export { defineLofiApp, type LofiAppConfig } from "./app.ts";
export {
  type AuthCapability,
  authenticateDeviceCredential,
  AuthError,
  classifyCredentialOrigin,
  type CredentialOriginReport,
  decryptAtRest,
  deriveAtRestKey,
  derivePrfSecret,
  encryptAtRest,
  enrollDeviceCredential,
  getAuthCapability,
} from "./auth.ts";
export { bootLofi } from "./boot.ts";
export {
  assertDurableBrowser,
  type DeviceCapabilityReport,
  DurableStorageUnsupportedError,
  readDeviceCapabilityReport,
  requestPersistentStorage,
} from "./device-capabilities.ts";
export {
  applyPwaUpdate,
  createPwaController,
  getPwaState,
  type InstallPromptEvent,
  type PwaController,
  pwaController,
  type PwaFailureCode,
  pwaFailureMessage,
  type PwaInstallState,
  type PwaState,
  type PwaWorkerState,
  requestPwaInstall,
  subscribePwaState,
} from "./pwa.ts";
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
export { RecoverablePasskeyError, type RecoverablePasskeyErrorCode } from "./passkey-recovery.ts";
export {
  type TableHandle,
  type TableRow,
  type TableSnapshot,
  type TableStore,
} from "./table-store.ts";
export { settleUiMutation } from "./ui-mutation.ts";
