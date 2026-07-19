/**
 * Browser-availability failure handling: {@link BrowserUnavailableError} with
 * actionable install guidance, and the launch-error classifier that raises it.
 *
 * @module
 */

// The one place the testing helpers spell the Chromium install command; the
// version matches the `playwright` alias in the workspace import map.
const PLAYWRIGHT_INSTALL_COMMAND = "deno run -A npm:playwright@1.61.1 install chromium";

/** Thrown when Playwright's Chromium browser is not installed, with install guidance. */
export class BrowserUnavailableError extends Error {
  /** Always `"BrowserUnavailableError"`. */
  override readonly name = "BrowserUnavailableError";

  /**
   * Builds the error with a fixed install-guidance message.
   * @param options standard error options, e.g. a `cause` to chain the launch failure.
   */
  constructor(options?: ErrorOptions) {
    super(
      `Playwright Chromium is not installed. Run \`${PLAYWRIGHT_INSTALL_COMMAND}\` and retry.`,
      options,
    );
  }
}

/**
 * Rethrow a browser launch failure as a {@link BrowserUnavailableError} when the
 * message indicates a missing Chromium install; otherwise rethrow it unchanged.
 */
export function rethrowBrowserLaunchError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /executable doesn't exist|browser executable|playwright install|failed to launch/i.test(message)
  ) {
    throw new BrowserUnavailableError({ cause: error });
  }
  throw error;
}
