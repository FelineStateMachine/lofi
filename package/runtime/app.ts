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
  name: string;
  databaseName: string;
  schema: Schema;
  storage: "durable";
  credentialOrigins?: readonly string[];
  /**
   * Recoverable passkeys are scoped to this relying-party ID. Pin the canonical
   * production hostname before users create backups. When omitted, the current
   * hostname is used, which is convenient locally but preview-host specific.
   */
  passkey?: { rpId?: string };
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

/**
 * Defines the application-facing values the versioned runtime needs.
 *
 * The returned value retains the exact schema type so author code can select
 * tables without importing or editing framework internals.
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
