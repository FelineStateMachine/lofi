import type { Page } from "npm:playwright@1.61.1";

export interface ReadinessOptions {
  /** A useful name for the condition, included when Playwright times out. */
  description?: string;
  /** Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Uses Playwright's event-loop polling; no fixed sleep is introduced. */
  polling?: "raf" | number;
}

export class ReadinessError extends Error {
  override readonly name = "ReadinessError";

  constructor(description: string, options?: ErrorOptions) {
    super(`Page did not become ready: ${description}`, options);
  }
}

/**
 * Wait for an app-owned browser predicate. The predicate runs in the page and
 * Playwright owns the timeout/polling, so tests do not need arbitrary sleeps.
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
