/**
 * Opt-in helpers for installed-app launch handling and safe client reuse.
 *
 * @module
 */

/** Launch data delivered by a browser `LaunchQueue`. */
export type InstalledAppLaunchParameters = {
  targetURL?: string;
  files?: readonly FileSystemHandle[];
};

/** Minimal browser launch-queue seam used by the recipe. */
export type InstalledAppLaunchQueue = {
  setConsumer(consumer: (parameters: InstalledAppLaunchParameters) => void): void;
};

/** A parsed launch URL proven to stay inside the configured application scope. */
export type InstalledAppLaunchTarget = {
  url: string;
};

/** Stable rejection that never contains the received launch URL. */
export type InstalledAppLaunchIssue =
  | "missing-target"
  | "invalid-target"
  | "credentialed-target"
  | "outside-origin"
  | "outside-scope";

/** Accepted in-scope launch target or value-free rejection. */
export type InstalledAppLaunchResult =
  | { ok: true; target: InstalledAppLaunchTarget }
  | { ok: false; issue: InstalledAppLaunchIssue };

/** Options for registering one launch-queue consumer. */
export type InstallLaunchConsumerOptions = {
  /** Absolute application scope URL, normally derived from `import.meta.env.BASE_URL`. */
  scope: string | URL;
  /** Override the browser queue for tests. */
  queue?: InstalledAppLaunchQueue;
  /** Receives only parsed same-origin, in-scope launch targets. */
  onLaunch(target: InstalledAppLaunchTarget): void;
  /** Receives a value-free reason for rejected external input. */
  onRejected?(issue: InstalledAppLaunchIssue): void;
};

/** Result of feature-detecting and registering the launch consumer. */
export type InstalledLaunchConsumer = {
  supported: boolean;
  dispose(): void;
};

const owners = new WeakMap<InstalledAppLaunchQueue, symbol>();

function configuredScope(value: string | URL): URL {
  const scope = value instanceof URL ? new URL(value.href) : new URL(value);
  if (
    scope.protocol !== "https:" && scope.protocol !== "http:" || scope.username ||
    scope.password || scope.search || scope.hash || !scope.pathname.endsWith("/")
  ) {
    throw new TypeError(
      "launch scope must be an absolute HTTP(S) URL without credentials, query, or fragment and with a trailing slash",
    );
  }
  return scope;
}

function browserLaunchQueue(): InstalledAppLaunchQueue | undefined {
  return (globalThis as typeof globalThis & { launchQueue?: InstalledAppLaunchQueue }).launchQueue;
}

/** Parse one browser-provided launch URL against an exact origin and path scope. */
export function parseInstalledAppLaunchTarget(
  targetURL: string | undefined,
  scopeValue: string | URL,
): InstalledAppLaunchResult {
  if (!targetURL) return { ok: false, issue: "missing-target" };
  const scope = configuredScope(scopeValue);
  let target: URL;
  try {
    target = new URL(targetURL);
  } catch {
    return { ok: false, issue: "invalid-target" };
  }
  if (target.username || target.password) return { ok: false, issue: "credentialed-target" };
  if (target.origin !== scope.origin) return { ok: false, issue: "outside-origin" };
  if (!target.pathname.startsWith(scope.pathname)) {
    return { ok: false, issue: "outside-scope" };
  }
  return { ok: true, target: { url: target.href } };
}

/**
 * Feature-detect and install one early launch-queue consumer.
 *
 * The most recently installed consumer owns the queue. Disposing an older
 * development/HMR generation cannot replace the newer consumer; disposing the
 * current owner installs a no-op consumer so stale callbacks stop handling
 * launches.
 */
export function installInstalledAppLaunchConsumer(
  options: InstallLaunchConsumerOptions,
): InstalledLaunchConsumer {
  const queue = options.queue ?? browserLaunchQueue();
  if (!queue) return { supported: false, dispose() {} };
  const scope = configuredScope(options.scope);
  const owner = Symbol("lofi-launch-consumer");
  let active = true;
  owners.set(queue, owner);
  queue.setConsumer((parameters) => {
    if (!active || owners.get(queue) !== owner) return;
    const result = parseInstalledAppLaunchTarget(parameters.targetURL, scope);
    if (result.ok) options.onLaunch(result.target);
    else options.onRejected?.(result.issue);
  });
  return {
    supported: true,
    dispose() {
      if (!active) return;
      active = false;
      if (owners.get(queue) !== owner) return;
      owners.delete(queue);
      queue.setConsumer(() => {});
    },
  };
}
