import type { BrowserTestClient } from "./fixture.ts";
import type { ValueFreeState } from "./safety.ts";

export interface OfflineTestClient {
  readonly offline: boolean;
  goOffline(): Promise<void>;
  goOnline(): Promise<void>;
}

export interface OfflineTestFixture<Client extends OfflineTestClient> {
  readonly clients: readonly [Client, Client];
  readonly first: Client;
  readonly second: Client;
  goOffline(): Promise<void>;
  goOnline(): Promise<void>;
  captureFailure(
    label: string,
    snapshot?: (client: Client) => Promise<ValueFreeState>,
  ): Promise<unknown>;
}

export interface ConcurrentOfflineScenario<
  Edit,
  Client extends OfflineTestClient = BrowserTestClient,
> {
  readonly edits: readonly [Edit, Edit];
  /** App-owned, deterministic readiness assertion (locator/waitForFunction/etc.). */
  readonly ready: (client: Client) => Promise<void>;
  readonly apply: (client: Client, edit: Edit) => Promise<void>;
  readonly locallyApplied: (client: Client, edit: Edit) => Promise<void>;
  /** Use this hook for page/client restart while offline work is pending. */
  readonly whilePending?: (fixture: OfflineTestFixture<Client>) => Promise<void>;
  /** Must resolve only when both app views have converged, or reject on timeout. */
  readonly converged: (fixture: OfflineTestFixture<Client>) => Promise<void>;
  readonly snapshot?: (client: Client) => Promise<ValueFreeState>;
  readonly failureLabel?: string;
}

export class ConvergenceScenarioError extends Error {
  override readonly name = "ConvergenceScenarioError";

  constructor(readonly stage: string, options?: ErrorOptions) {
    super(`Concurrent offline convergence failed during ${stage}`, options);
  }
}

/**
 * Coordinates the transport lifecycle while the app owns edits, assertions and
 * conflict semantics. Both offline edits are started in the same microtask.
 */
export async function runConcurrentOfflineConvergence<Edit, Client extends OfflineTestClient>(
  fixture: OfflineTestFixture<Client>,
  scenario: ConcurrentOfflineScenario<Edit, Client>,
): Promise<void> {
  let stage = "readiness";
  try {
    await Promise.all(fixture.clients.map((client) => scenario.ready(client)));
    stage = "going offline";
    await fixture.goOffline();
    stage = "concurrent edits";
    await Promise.all([
      scenario.apply(fixture.first, scenario.edits[0]),
      scenario.apply(fixture.second, scenario.edits[1]),
    ]);
    stage = "local persistence";
    await Promise.all([
      scenario.locallyApplied(fixture.first, scenario.edits[0]),
      scenario.locallyApplied(fixture.second, scenario.edits[1]),
    ]);
    stage = "pending-work hook";
    await scenario.whilePending?.(fixture);
    stage = "reconnection";
    await fixture.goOnline();
    stage = "convergence";
    await scenario.converged(fixture);
  } catch (error) {
    await fixture.captureFailure(
      scenario.failureLabel ?? `offline-convergence-${stage}`,
      scenario.snapshot,
    ).catch(() => undefined);
    throw new ConvergenceScenarioError(stage, { cause: error });
  } finally {
    await Promise.allSettled(
      fixture.clients.filter((client) => client.offline).map((client) => client.goOnline()),
    );
  }
}
