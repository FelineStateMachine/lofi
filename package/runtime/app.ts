/**
 * Author-owned configuration consumed by the package runtime.
 *
 * @example
 * ```ts
 * const config: LofiAppConfig<typeof schema> = {
 *   name: "my-app",
 *   databaseName: "my-app",
 *   schema,
 *   storage: "durable",
 *   sync: { adapter: "jazz" },
 * };
 * ```
 */
export type LofiAppConfig<Schema = unknown> = {
  /** Display name, used for the PWA and as the passkey label. Must be non-empty. */
  name: string;
  /** Name of the local database the runtime opens. Must be non-empty. */
  databaseName: string;
  /** The app's Jazz schema, as returned by the `@nzip/lofi/schema` define entry points. */
  schema: Schema;
  /** Storage durability contract. `durable` is the only supported mode. */
  storage: "durable";
  /**
   * Allowlist of hostnames considered committed-stable for enrolling device
   * credentials: exact hostnames or `*.` suffix patterns. A deployed HTTPS
   * host not on this list classifies as `unverified` and passkey enrollment
   * refuses there — with the list omitted or empty, enrollment works only on
   * localhost. Add the production hostname before shipping passkey features.
   */
  credentialOrigins?: readonly string[];
  /**
   * Recoverable passkeys are scoped to this relying-party ID. Pin the canonical
   * production hostname before users create backups. When omitted, the current
   * hostname is used, which is convenient locally but preview-host specific.
   */
  passkey?: { rpId?: string };
  /**
   * Optional PWA update-lifecycle preferences. Omitting the block keeps the
   * safe defaults: the framework's minimal read-only banner renders when
   * local data is newer than the running bundle, and tabs left on a stale
   * revision after a worker swap reload onto the new one.
   */
  pwa?: {
    /**
     * `default` renders the framework's minimal schema-compatibility banner;
     * `none` suppresses it for apps that render their own from
     * `useSchemaCompat`.
     */
    updateBanner?: "default" | "none";
    /**
     * How a tab that did not initiate an update behaves once a new worker
     * controls it: `reload` (default) reloads onto the new revision; `prompt`
     * keeps the document read-only and asks the user to reload.
     */
    staleTabs?: "reload" | "prompt";
    /**
     * `default` renders the framework's minimal notice when an installed
     * WebKit app starts in a fresh storage container while local data exists
     * in the browser; `none` suppresses it for apps that render their own
     * from `useStorageFork`.
     */
    forkNotice?: "default" | "none";
  };
  sync: { adapter: "jazz" };
  repositoryUrl?: string;
};

type AppSlot = { config?: LofiAppConfig };

const slotName = "__LOFI_APP_DEFINITION__";
const browserGlobal = globalThis as typeof globalThis & { [slotName]?: AppSlot };

function slot(): AppSlot {
  browserGlobal[slotName] ??= {};
  return browserGlobal[slotName];
}

/** Raised when package runtime startup cannot resolve valid author-owned app configuration. */
export class LofiConfigurationError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "LofiConfigurationError";
  /** Stable category for runtime startup classification. */
  readonly code = "configuration-error";
}

/** True when an error is invalid or missing author-owned app configuration. */
export function isLofiConfigurationError(error: unknown): error is LofiConfigurationError {
  return error instanceof LofiConfigurationError;
}

/**
 * Defines the application-facing values the versioned runtime needs.
 *
 * The returned value retains the exact schema type so author code can select
 * tables without importing or editing framework internals. Calling it also
 * registers the configuration globally so runtime entry points (`bootLofi`,
 * `getRuntime`) can resolve it — import the defining module before booting.
 *
 * @example
 * ```ts
 * import { defineLofiApp } from "@nzip/lofi";
 * import { app as schema } from "./schema.ts";
 *
 * export const app = defineLofiApp({
 *   name: "my-app",
 *   databaseName: "my-app",
 *   schema,
 *   storage: "durable",
 *   sync: { adapter: "jazz" },
 * });
 * ```
 *
 * @param config The author-owned app configuration, including the raw Jazz schema.
 * @returns The same configuration, typed to the exact schema for table selection.
 * @throws {LofiConfigurationError} When `name` or `databaseName` is empty.
 */
export function defineLofiApp<const Schema>(
  config: LofiAppConfig<Schema>,
): LofiAppConfig<Schema> {
  if (!config.name.trim()) throw new LofiConfigurationError("lofi app name must not be empty");
  if (!config.databaseName.trim()) {
    throw new LofiConfigurationError("lofi database name must not be empty");
  }
  slot().config = config;
  return config;
}

/** Package-internal lookup used when browser resources are opened lazily. */
export function getLofiApp(): LofiAppConfig {
  const config = slot().config;
  if (!config) {
    throw new LofiConfigurationError(
      "lofi app is not defined; export defineLofiApp({...}) from src/app.ts before booting the runtime",
    );
  }
  return config;
}
