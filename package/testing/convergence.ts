import type { BrowserTestClient } from "./fixture.ts";
import type { ValueFreeState } from "./safety.ts";

/** Minimal client contract the convergence runner needs: offline state and toggles. */
export interface OfflineTestClient {
  readonly offline: boolean;
  goOffline(): Promise<void>;
  goOnline(): Promise<void>;
}

/** Minimal two-client fixture contract required to drive an offline scenario. */
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

/**
 * App-owned definition of a concurrent-offline convergence test: the two edits
 * plus the hooks that assert readiness, apply and locally verify each edit, and
 * confirm convergence after reconnection.
 */
export interface ConcurrentOfflineScenario<
  Edit,
  Client extends OfflineTestClient = BrowserTestClient,
> {
  readonly edits: readonly [Edit, Edit];
  /** Overall defensive deadline. Defaults to 60 seconds. */
  readonly timeoutMs?: number;
  /** App-owned, deterministic readiness assertion (locator/waitForFunction/etc.). */
  readonly ready: (client: Client, signal: AbortSignal) => Promise<void>;
  readonly apply: (client: Client, edit: Edit, signal: AbortSignal) => Promise<void>;
  readonly locallyApplied: (client: Client, edit: Edit, signal: AbortSignal) => Promise<void>;
  /** Use this hook for page/client restart while offline work is pending. */
  readonly whilePending?: (
    fixture: OfflineTestFixture<Client>,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Must resolve only when both app views have converged, or reject on timeout. */
  readonly converged: (
    fixture: OfflineTestFixture<Client>,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly snapshot?: (client: Client) => Promise<ValueFreeState>;
  readonly failureLabel?: string;
}

/** Thrown when a convergence scenario fails, naming the stage that failed via {@link stage}. */
export class ConvergenceScenarioError extends Error {
  override readonly name = "ConvergenceScenarioError";

  /** @param stage the lifecycle stage that was in progress when the scenario failed */
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
  const timeoutMs = scenario.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("convergence timeoutMs must be a positive finite number");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`convergence exceeded its ${timeoutMs}ms deadline`)),
    timeoutMs,
  );
  const withinDeadline = async <Result>(operation: Promise<Result>): Promise<Result> => {
    if (controller.signal.aborted) throw controller.signal.reason;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
  let stage = "readiness";
  try {
    await withinDeadline(
      Promise.all(fixture.clients.map((client) => scenario.ready(client, controller.signal))),
    );
    stage = "going offline";
    await withinDeadline(fixture.goOffline());
    stage = "concurrent edits";
    await withinDeadline(
      Promise.all([
        scenario.apply(fixture.first, scenario.edits[0], controller.signal),
        scenario.apply(fixture.second, scenario.edits[1], controller.signal),
      ]),
    );
    stage = "local persistence";
    await withinDeadline(
      Promise.all([
        scenario.locallyApplied(fixture.first, scenario.edits[0], controller.signal),
        scenario.locallyApplied(fixture.second, scenario.edits[1], controller.signal),
      ]),
    );
    stage = "pending-work hook";
    if (scenario.whilePending) {
      await withinDeadline(scenario.whilePending(fixture, controller.signal));
    }
    stage = "reconnection";
    await withinDeadline(fixture.goOnline());
    stage = "convergence";
    await withinDeadline(scenario.converged(fixture, controller.signal));
  } catch (error) {
    await fixture.captureFailure(
      scenario.failureLabel ?? `offline-convergence-${stage}`,
      scenario.snapshot,
    ).catch(() => undefined);
    throw new ConvergenceScenarioError(stage, { cause: error });
  } finally {
    clearTimeout(timeout);
    await Promise.allSettled(
      fixture.clients.filter((client) => client.offline).map((client) => client.goOnline()),
    );
  }
}
