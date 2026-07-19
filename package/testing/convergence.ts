import type { BrowserTestClient } from "./fixture.ts";
import type { ValueFreeState } from "./safety.ts";

/** Minimal client contract the convergence runner needs: offline state and toggles. */
export interface OfflineTestClient {
  /** Whether the client's network is currently forced offline. */
  readonly offline: boolean;
  /** Force this client's network offline. */
  goOffline(): Promise<void>;
  /** Restore this client's network. */
  goOnline(): Promise<void>;
}

/** Minimal two-client fixture contract required to drive an offline scenario. */
export interface OfflineTestFixture<Client extends OfflineTestClient> {
  /** Both clients, ordered `[first, second]`. */
  readonly clients: readonly [Client, Client];
  /** The first client. */
  readonly first: Client;
  /** The second client. */
  readonly second: Client;
  /** Take both clients offline. */
  goOffline(): Promise<void>;
  /** Bring both clients back online. */
  goOnline(): Promise<void>;
  /**
   * Capture a redacted failure artifact, optionally including a value-free
   * per-client snapshot. Returns an opaque handle describing what was written.
   */
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
  /** The two concurrent edits, one applied on each client while offline. */
  readonly edits: readonly [Edit, Edit];
  /** Overall defensive deadline. Defaults to 60 seconds. */
  readonly timeoutMs?: number;
  /** App-owned, deterministic readiness assertion (locator/waitForFunction/etc.). */
  readonly ready: (client: Client, signal: AbortSignal) => Promise<void>;
  /** Apply one client's edit while it is offline. */
  readonly apply: (client: Client, edit: Edit, signal: AbortSignal) => Promise<void>;
  /** Assert the edit is visible locally on its own client before reconnection. */
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
  /** Optional value-free snapshot taken per client when a failure is captured. */
  readonly snapshot?: (client: Client) => Promise<ValueFreeState>;
  /** Label for any captured failure artifact. Defaults to a generic name. */
  readonly failureLabel?: string;
}

/** The lifecycle stages the convergence runner moves through, in order. */
export type ConvergenceStage =
  | "readiness"
  | "going offline"
  | "concurrent edits"
  | "local persistence"
  | "pending-work hook"
  | "reconnection"
  | "convergence";

/** Options for {@link ConvergenceScenarioError}, extending `ErrorOptions` with the capture outcome. */
export interface ConvergenceScenarioErrorOptions extends ErrorOptions {
  /** The failure raised while capturing artifacts, when capture itself failed. */
  captureError?: unknown;
}

/** Thrown when a convergence scenario fails, naming the stage that failed via {@link stage}. */
export class ConvergenceScenarioError extends Error {
  /** Always `"ConvergenceScenarioError"`. */
  override readonly name = "ConvergenceScenarioError";

  /**
   * The failure raised by the fixture's `captureFailure` while this error was
   * being produced — e.g. a `snapshot` callback that violates the value-free
   * rule — or `undefined` when the artifacts were captured. The scenario
   * failure itself stays in {@link Error.cause}.
   */
  readonly captureError?: unknown;

  /**
   * Builds the error, recording which lifecycle stage was in progress.
   * @param stage the lifecycle stage that was in progress when the scenario failed
   * @param options standard error options, e.g. a `cause` from the failing hook,
   * plus the artifact-capture failure when capture also failed
   */
  constructor(readonly stage: ConvergenceStage, options?: ConvergenceScenarioErrorOptions) {
    const captureNote = options?.captureError !== undefined
      ? "; failure-artifact capture also failed (see captureError)"
      : "";
    super(`Concurrent offline convergence failed during ${stage}${captureNote}`, options);
    this.captureError = options?.captureError;
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
  let stage: ConvergenceStage = "readiness";
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
    // A capture failure never masks the scenario failure: the scenario error
    // stays the thrown error, and the capture failure rides along on it.
    let captureError: unknown;
    try {
      await fixture.captureFailure(
        scenario.failureLabel ?? `offline-convergence-${stage}`,
        scenario.snapshot,
      );
    } catch (failure) {
      captureError = failure ?? new Error("failure-artifact capture rejected without a reason");
    }
    throw new ConvergenceScenarioError(stage, { cause: error, captureError });
  } finally {
    clearTimeout(timeout);
    await Promise.allSettled(
      fixture.clients.filter((client) => client.offline).map((client) => client.goOnline()),
    );
  }
}
