/**
 * Optional Preact bindings for lofi device capabilities and PWA controls.
 *
 * These components are package-owned examples that application layouts may
 * compose or replace with UI built on the same public runtime APIs.
 *
 * @module
 */
export { default as DeviceStatus } from "./DeviceStatus.tsx";
export { RuntimeRecovery, type RuntimeRecoveryProps } from "./RuntimeRecovery.tsx";
export {
  PwaActions,
  type PwaActionsProps,
  type PwaController,
  type PwaFailureCode,
  pwaFailureMessage,
  type PwaState,
  usePwaState,
} from "./PwaActions.tsx";
export {
  type DeviceCapabilitiesHook,
  type DeviceCapabilityReport,
  useDeviceCapabilities,
} from "./use-device-capabilities.ts";
