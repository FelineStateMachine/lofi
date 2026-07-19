import type { Page } from "playwright";

/** Options controlling {@link waitForReady}'s description, timeout, and polling. */
export interface ReadinessOptions {
  /** A useful name for the condition, included when Playwright times out. */
  description?: string;
  /** Defaults to 10 seconds. */
  timeoutMs?: number;
  /**
   * `"raf"` re-checks on every animation frame; a number re-checks at that
   * fixed interval in milliseconds.
   * @default "raf"
   */
  polling?: "raf" | number;
}

/** Thrown when the readiness predicate does not become true before the timeout. */
export class ReadinessError extends Error {
  /** Always `"ReadinessError"`. */
  override readonly name = "ReadinessError";

  /**
   * Builds the error, embedding the condition that failed to become ready.
   * @param description the readiness condition that timed out, named in the message
   * @param options standard error options, e.g. a `cause` from the underlying timeout
   */
  constructor(description: string, options?: ErrorOptions) {
    super(`Page did not become ready: ${description}`, options);
  }
}

function isReadinessOptions(value: unknown): value is ReadinessOptions | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every(
    (key) => key === "description" || key === "timeoutMs" || key === "polling",
  );
}

/**
 * Wait for an app-owned browser predicate that takes no argument. The predicate
 * runs in the page and Playwright owns the timeout/polling, so tests do not
 * need arbitrary sleeps.
 *
 * @example
 * ```ts
 * import { waitForReady } from "@nzip/lofi/testing";
 *
 * await waitForReady(client.page, () => document.querySelector(".task-list") !== null, {
 *   description: "task list rendered",
 * });
 * ```
 *
 * @param page The Playwright page to poll.
 * @param predicate An app-owned readiness check evaluated inside the page.
 * @param options Optional description, timeout, and polling configuration.
 * @returns Resolves when the predicate becomes true; rejects with {@link ReadinessError} on timeout.
 */
export function waitForReady(
  page: Page,
  predicate: () => boolean | Promise<boolean>,
  options?: ReadinessOptions,
): Promise<void>;
/**
 * Wait for an app-owned browser predicate, passing it a serialized argument.
 *
 * @param page The Playwright page to poll.
 * @param predicate An app-owned readiness check evaluated inside the page.
 * @param argument A serializable value passed to the predicate in the page.
 * @param options Optional description, timeout, and polling configuration.
 * @returns Resolves when the predicate becomes true; rejects with {@link ReadinessError} on timeout.
 */
export function waitForReady<Argument>(
  page: Page,
  predicate: (argument: Argument) => boolean | Promise<boolean>,
  argument: Argument,
  options?: ReadinessOptions,
): Promise<void>;
export async function waitForReady<Argument>(
  page: Page,
  predicate: (argument: Argument) => boolean | Promise<boolean>,
  argumentOrOptions?: Argument | ReadinessOptions,
  maybeOptions?: ReadinessOptions,
): Promise<void> {
  // A three-argument call carries options in third position only for the
  // zero-parameter overload; a predicate argument otherwise rides there.
  const optionsInThird = maybeOptions === undefined && predicate.length === 0 &&
    isReadinessOptions(argumentOrOptions);
  const options = (optionsInThird ? argumentOrOptions as ReadinessOptions : maybeOptions) ?? {};
  const argument = optionsInThird ? undefined : argumentOrOptions;
  const description = options.description ?? "application readiness predicate";
  try {
    // Playwright internally maps serializable values to its Unboxed<T> type.
    await page.waitForFunction(predicate as never, argument as never, {
      polling: options.polling ?? "raf",
      timeout: options.timeoutMs ?? 10_000,
    });
  } catch (error) {
    throw new ReadinessError(description, { cause: error });
  }
}
