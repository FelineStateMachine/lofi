/**
 * Bootstrap a managed Jazz app for a lofi project.
 *
 * Local-first projects run with no configuration at all. To turn on managed sync
 * — so a user can elect to back up and roam their account — a project needs a
 * Jazz app id and the managed sync server. Jazz's dashboard exposes a public
 * endpoint that mints a fresh app and hands back its secrets; the app is
 * unclaimed and expires unless you claim it from the dashboard within the
 * grace window.
 *
 * This module is the small, honest primitive behind `deno task jazz:provision`
 * and `create --sync`: it calls that endpoint, maps the response onto lofi's
 * four environment names, and merges them into a `.env` file without disturbing
 * anything else there. Secrets are written to the (git-ignored) file, never
 * echoed to stdout.
 *
 * @module
 */

import { environmentNames, parseDotenv } from "./environment.ts";

/** Jazz's public app-generation endpoint. Returns a fresh, unclaimed app. */
export const JAZZ_GENERATE_ENDPOINT = "https://v2.dashboard.jazz.tools/api/apps/generate";
/** The managed Jazz Cloud sync server a generated app syncs against. */
export const JAZZ_MANAGED_SERVER_URL = "https://v2.sync.jazz.tools/";
/** Where a generated app is claimed before it expires. */
export const JAZZ_DASHBOARD_URL = "https://v2.dashboard.jazz.tools/";
/** How long an unclaimed app survives — stated to the user, not enforced here. */
export const JAZZ_CLAIM_WINDOW_DAYS = 14;

/** The secrets a freshly generated Jazz app is provisioned with. */
export type GeneratedJazzApp = {
  /** Public app id (client-visible). Maps to `JAZZ_APP_ID`. */
  appId: string;
  /** Admin secret for schema/permission deploys. Maps to `JAZZ_ADMIN_SECRET`. */
  adminSecret: string;
  /** Backend secret for server-side use. Maps to `BACKEND_SECRET`. */
  backendSecret: string;
};

/** A precise, non-leaking failure reason for provisioning. */
export class ProvisionError extends Error {
  override readonly name = "ProvisionError";
  constructor(message: string) {
    super(message);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Calls the Jazz app-generation endpoint and returns the new app's secrets.
 * `fetchImpl` is injectable so the flow is testable without a network.
 */
export async function generateJazzApp(
  fetchImpl: typeof fetch = fetch,
): Promise<GeneratedJazzApp> {
  let response: Response;
  try {
    response = await fetchImpl(JAZZ_GENERATE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (cause) {
    throw new ProvisionError(
      `could not reach the Jazz dashboard to generate an app (${
        cause instanceof Error ? cause.message : String(cause)
      }); check your connection and retry`,
    );
  }
  if (!response.ok) {
    throw new ProvisionError(
      `the Jazz dashboard rejected the app-generation request (HTTP ${response.status}); retry later`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProvisionError("the Jazz dashboard returned a response that was not valid JSON");
  }
  const record = (payload ?? {}) as Record<string, unknown>;
  if (
    !isNonEmptyString(record.appId) ||
    !isNonEmptyString(record.adminSecret) ||
    !isNonEmptyString(record.backendSecret)
  ) {
    throw new ProvisionError(
      "the Jazz dashboard response was missing an appId, adminSecret, or backendSecret",
    );
  }
  return {
    appId: record.appId.trim(),
    adminSecret: record.adminSecret.trim(),
    backendSecret: record.backendSecret.trim(),
  };
}

/** The four environment values a generated app populates. */
export function environmentForApp(
  app: GeneratedJazzApp,
  serverUrl: string = JAZZ_MANAGED_SERVER_URL,
): Record<string, string> {
  return {
    JAZZ_APP_ID: app.appId,
    JAZZ_SERVER_URL: serverUrl,
    JAZZ_ADMIN_SECRET: app.adminSecret,
    BACKEND_SECRET: app.backendSecret,
  };
}

/**
 * Merges `values` into the text of a `.env` file, updating existing assignments
 * in place and appending any that are absent. Every other line — comments,
 * blank lines, unrelated keys — is preserved verbatim.
 */
export function mergeEnv(existing: string, values: Record<string, string>): string {
  const remaining = new Map(Object.entries(values));
  const lines = existing.length === 0 ? [] : existing.split("\n");
  const updated = lines.map((line) => {
    const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/.exec(line);
    if (!match) return line;
    const name = match[2];
    if (!remaining.has(name)) return line;
    const value = remaining.get(name)!;
    remaining.delete(name);
    return `${match[1]}${name}=${value}`;
  });
  if (remaining.size > 0) {
    if (updated.length > 0 && updated[updated.length - 1].trim() !== "") updated.push("");
    for (const [name, value] of remaining) updated.push(`${name}=${value}`);
  }
  return `${updated.join("\n").replace(/\n+$/, "")}\n`;
}

/** Whether a parsed `.env` already points at a configured (non-empty) app. */
function alreadyConfigured(existing: string): boolean {
  const parsed = parseDotenv(existing);
  return isNonEmptyString(parsed.JAZZ_APP_ID);
}

/** The outcome of a provisioning run, for the caller to report. */
export type ProvisionResult = {
  app: GeneratedJazzApp;
  serverUrl: string;
  /** The absolute or relative path the environment was written to. */
  path: string;
  /** Whether an existing configured app was replaced. */
  replaced: boolean;
};

export type ProvisionOptions = {
  /** The `.env` path to write. */
  path: string;
  /** Overwrite an already-configured `JAZZ_APP_ID`. */
  force?: boolean;
  /** Injectable network + filesystem for testing. */
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, contents: string) => Promise<void>;
};

const defaultReadFile = async (path: string): Promise<string> => {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "";
    throw error;
  }
};

const defaultWriteFile = (path: string, contents: string): Promise<void> =>
  Deno.writeTextFile(path, contents);

/**
 * Generates a Jazz app and writes its configuration into `options.path`,
 * refusing to clobber an already-configured app unless `force` is set. Returns
 * what was provisioned; never returns or logs the secrets.
 */
export async function provisionJazzApp(options: ProvisionOptions): Promise<ProvisionResult> {
  const readFile = options.readFile ?? defaultReadFile;
  const writeFile = options.writeFile ?? defaultWriteFile;
  const existing = await readFile(options.path);
  const replaced = alreadyConfigured(existing);
  if (replaced && !options.force) {
    throw new ProvisionError(
      `${options.path} already configures JAZZ_APP_ID; rerun with --force to replace it, or edit the file by hand`,
    );
  }
  const app = await generateJazzApp(options.fetchImpl);
  const serverUrl = JAZZ_MANAGED_SERVER_URL;
  const merged = mergeEnv(existing, environmentForApp(app, serverUrl));
  await writeFile(options.path, merged);
  return { app, serverUrl, path: options.path, replaced };
}

// A defensive guard so a future edit to the env-name list cannot silently drop
// one of the four names this module writes.
const _names: readonly string[] = environmentNames;
if (
  !["JAZZ_APP_ID", "JAZZ_SERVER_URL", "JAZZ_ADMIN_SECRET", "BACKEND_SECRET"].every((name) =>
    _names.includes(name)
  )
) {
  throw new Error("provision: environment name list drifted from the four provisioned names");
}
