/**
 * The shared-column registry: `s.sharedEncrypted*` constructors record their
 * configuration here at schema-definition time, and the runtime reads it at
 * boot to start the wrapped-key watcher and to seal writes with the right
 * scope. Module-level for the same reason the encrypted-column registry is —
 * schema definition happens before any runtime exists.
 *
 * @module
 */

/** The wiring one shared column declares: where its group and keys live. */
export type SharedColumnConfig = {
  /** The column's cryptographic label, conventionally `"table.column"`. */
  label: string;
  /** The group table whose membership scopes the field key. */
  group: string;
  /** The sibling column on the row that references the group. */
  groupIdColumn: string;
  /** The wrapped-key table (declared with `sharedFieldKeyTable`). */
  keys: string;
  /** The key-directory table (declared with `sharedFieldDirectoryTable`). */
  directory: string;
};

const configs = new Map<string, SharedColumnConfig>();

/** Records one shared column's wiring; keyed by label. */
export function registerSharedColumn(config: SharedColumnConfig): void {
  configs.set(config.label, config);
}

/** Every registered shared-column configuration. */
export function sharedColumnConfigs(): SharedColumnConfig[] {
  return [...configs.values()];
}

/** The registered configuration for a label, if any. */
export function sharedColumnConfig(label: string): SharedColumnConfig | undefined {
  return configs.get(label);
}

/** Empties the registry; tests call this between schemas. */
export function clearSharedColumnRegistry(): void {
  configs.clear();
}
