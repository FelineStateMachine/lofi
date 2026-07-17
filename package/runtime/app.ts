/** Author-owned configuration consumed by the package runtime. */
export type LofiAppConfig<Schema = unknown> = {
  name: string;
  databaseName: string;
  schema: Schema;
  storage: "durable";
  credentialOrigins?: readonly string[];
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

/**
 * Defines the application-facing values the versioned runtime needs.
 *
 * The returned value retains the exact schema type so author code can select
 * tables without importing or editing framework internals.
 */
export function defineLofiApp<const Schema>(
  config: LofiAppConfig<Schema>,
): LofiAppConfig<Schema> {
  if (!config.name.trim()) throw new Error("lofi app name must not be empty");
  if (!config.databaseName.trim()) throw new Error("lofi database name must not be empty");
  slot().config = config;
  return config;
}

/** Package-internal lookup used when browser resources are opened lazily. */
export function getLofiApp(): LofiAppConfig {
  const config = slot().config;
  if (!config) {
    throw new Error(
      "lofi app is not defined; export defineLofiApp({...}) from src/app.ts before booting the runtime",
    );
  }
  return config;
}
