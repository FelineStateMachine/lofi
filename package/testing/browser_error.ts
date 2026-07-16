export class BrowserUnavailableError extends Error {
  override readonly name = "BrowserUnavailableError";

  constructor(options?: ErrorOptions) {
    super(
      "Playwright Chromium is not installed. Run `deno run -A npm:playwright@1.61.1 install chromium` and retry.",
      options,
    );
  }
}

export function rethrowBrowserLaunchError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /executable doesn't exist|browser executable|playwright install|failed to launch/i.test(message)
  ) {
    throw new BrowserUnavailableError({ cause: error });
  }
  throw error;
}
