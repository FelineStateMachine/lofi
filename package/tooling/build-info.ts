/**
 * The `dist/lofi-build.json` contract: the build identity `deno task build`
 * writes next to the static output and `deno task preview` and the PWA
 * validation read back.
 *
 * @module
 */

/** The build identity recorded in `dist/lofi-build.json`. */
export interface LofiBuildInfo {
  /** The `@nzip/lofi` version that produced the build. */
  lofiVersion: string;
  /** The source fingerprint of the build, matching the service worker revision. */
  sourceHash: string;
  /** The deployment base path the output was built for. */
  basePath: string;
  /** ISO 8601 timestamp of when the build was written. */
  builtAt: string;
  /** The site-wide Content-Security-Policy union, present when built pages carry CSP meta tags. */
  csp?: string;
}
