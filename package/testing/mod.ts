/**
 * The `@nzip/lofi/testing` public surface: Playwright-backed helpers for testing
 * local-first behavior, including two-client fixtures, concurrent offline
 * convergence, app-owned readiness waits, value-free failure artifacts, and a
 * CDP virtual authenticator for headless WebAuthn flows.
 *
 * The supported Playwright release is 1.61 — the `playwright` alias in the
 * workspace import map. Install a matching Chromium with
 * `deno run -A npm:playwright@1.61.1 install chromium`.
 *
 * Alongside the browser fixtures, this entry re-exports the deterministic
 * seams of the schema and runtime registries — key installation, registry
 * clears, and fake runtime installation — so a test can isolate schema
 * declarations, encrypted and shared-field key state, write handles, and
 * verb dispatch without booting a runtime. Production code never calls these:
 * the runtime owns each seam at boot, and calling one in an application
 * corrupts the state the runtime maintains.
 *
 * @module
 */

export {
  type BrowserDiagnostic,
  BrowserTestClient,
  BrowserUnavailableError,
  type ClientName,
  createTwoClientFixture,
  type FailureArtifactOptions,
  type FailureArtifacts,
  type IdentityOptions,
  type MemoryStorageState,
  type SafeContextOptions,
  TwoClientFixture,
  type TwoClientFixtureOptions,
} from "./fixture.ts";
export {
  type ConcurrentOfflineScenario,
  ConvergenceScenarioError,
  type ConvergenceScenarioErrorOptions,
  type ConvergenceStage,
  type OfflineTestClient,
  type OfflineTestFixture,
  runConcurrentOfflineConvergence,
} from "./convergence.ts";
export { ReadinessError, type ReadinessOptions, waitForReady } from "./readiness.ts";
export { assertValueFreeState, redactDiagnosticText, type ValueFreeState } from "./safety.ts";
export {
  type VirtualAuthenticatorCredential,
  type VirtualAuthenticatorHandle,
  type VirtualAuthenticatorOptions,
  withVirtualAuthenticator,
} from "./webauthn.ts";

// Deterministic seams over the schema-side registries.
export {
  clearEffectDeclarations,
  type EffectContext,
  type MutationDescriptor,
  type MutationRuntime,
  setMutationRuntime,
} from "../schema/effects.ts";
export {
  clearEncryptedColumnKey,
  clearEncryptedColumnRegistry,
  setEncryptedColumnKey,
} from "../schema/encrypted.ts";
export {
  clearSharedFieldKeys,
  getSharedFieldKey,
  installSharedFieldKey,
  latestSharedFieldGeneration,
  sharedKeyScope,
  subscribeSharedKeyring,
} from "../schema/shared-keyring.ts";
export {
  clearSharedColumnRegistry,
  type SharedColumnConfig,
  sharedColumnConfigs,
} from "../schema/shared-registry.ts";

// Deterministic seams over the runtime.
export { clearFingerprintPins } from "../runtime/shared-field-keys.ts";
export {
  createWriteHandle,
  type WriteHandle,
  type WriteHandleController,
  type WriteRejection,
  type WriteStage,
} from "../runtime/write-handle.ts";
export { type DevicePublicKey, memoryPopKeyStore, type PopKeyStore } from "../runtime/pop.ts";
