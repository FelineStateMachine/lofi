/** The lifecycle stages a scenario moves through, in order. */
export type ScenarioStage =
  | "boot"
  | "deploy"
  | "peers"
  | "body"
  | "convergence"
  | "assertion"
  | "teardown";

/** Options for {@link ScenarioError}, extending `ErrorOptions` with scenario context. */
export interface ScenarioErrorOptions extends ErrorOptions {
  /** The peer whose action failed, when the failure is attributable to one peer. */
  peer?: string;
  /**
   * A preformatted multi-line report — e.g. the per-table, per-peer diff a
   * failed convergence produces — appended to the error message.
   */
  details?: string;
}

/** Thrown when a scenario fails, naming the lifecycle stage that failed via {@link stage}. */
export class ScenarioError extends Error {
  /** Always `"ScenarioError"`. */
  override readonly name = "ScenarioError";

  /** The peer whose action failed, or `undefined` when no single peer is at fault. */
  readonly peer?: string;

  /** The preformatted report passed via {@link ScenarioErrorOptions.details}, if any. */
  readonly details?: string;

  /**
   * Builds the error, recording which lifecycle stage was in progress.
   * @param stage the lifecycle stage that was in progress when the scenario failed
   * @param message what went wrong, in one line
   * @param options standard error options plus the failing peer and a detail report
   */
  constructor(readonly stage: ScenarioStage, message: string, options?: ScenarioErrorOptions) {
    const peerNote = options?.peer !== undefined ? ` (peer ${options.peer})` : "";
    const detailNote = options?.details !== undefined ? `\n${options.details}` : "";
    super(`Scenario failed during ${stage}${peerNote}: ${message}${detailNote}`, options);
    this.peer = options?.peer;
    this.details = options?.details;
  }
}
