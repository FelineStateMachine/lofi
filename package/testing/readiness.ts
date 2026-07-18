import type { Page } from "npm:playwright@1.61.1";

/** Options controlling {@link waitForReady}'s description, timeout, and polling. */
export interface ReadinessOptions {
  /** A useful name for the condition, included when Playwright times out. */
  description?: string;
  /** Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Uses Playwright's event-loop polling; no fixed sleep is introduced. */
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

/**
 * Wait for an app-owned browser predicate. The predicate runs in the page and
 * Playwright owns the timeout/polling, so tests do not need arbitrary sleeps.
 *
 * @example
 * ```ts
 * import { waitForReady } from "@nzip/lofi/testing";
 *
 * await waitForReady(client.page, () => document.querySelector(".task-list") !== null, undefined, {
 *   description: "task list rendered",
 * });
 * ```
 *
 * @param page The Playwright page to poll.
 * @param predicate An app-owned readiness check evaluated inside the page.
 * @param argument A serializable value passed to the predicate in the page.
 * @param options Optional description, timeout, and polling configuration.
 * @returns Resolves when the predicate becomes true; rejects with {@link ReadinessError} on timeout.
 */
export async function waitForReady<Argument>(
  page: Page,
  predicate: (argument: Argument) => boolean | Promise<boolean>,
  argument: Argument,
  options: ReadinessOptions = {},
): Promise<void> {
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
