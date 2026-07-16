/**
 * The `@nzip/lofi/testing` public surface: Playwright-backed helpers for testing
 * local-first behavior, including two-client fixtures, concurrent offline
 * convergence, app-owned readiness waits, value-free failure artifacts, and a
 * CDP virtual authenticator for headless WebAuthn flows.
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
  type SafeContextOptions,
  TwoClientFixture,
  type TwoClientFixtureOptions,
} from "./fixture.ts";
export {
  type ConcurrentOfflineScenario,
  ConvergenceScenarioError,
  type OfflineTestClient,
  type OfflineTestFixture,
  runConcurrentOfflineConvergence,
} from "./convergence.ts";
export { ReadinessError, type ReadinessOptions, waitForReady } from "./readiness.ts";
export type { ValueFreeState } from "./safety.ts";
export {
  type VirtualAuthenticatorHandle,
  type VirtualAuthenticatorOptions,
  withVirtualAuthenticator,
} from "./webauthn.ts";
