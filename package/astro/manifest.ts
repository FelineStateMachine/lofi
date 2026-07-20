/**
 * Static manifests of the package modules vendored into a project's `.lofi/`
 * directory. The lists are static because the published package cannot
 * enumerate directories over JSR; the manifest test fails when a list and its
 * package directory drift apart.
 *
 * @module
 */

/** Runtime modules vendored into `.lofi/`; kept in lockstep by the manifest test. */
export const runtimeFiles = [
  "app.ts",
  "auth-secret-lock.ts",
  "auth.ts",
  "boot-progress.ts",
  "boot.ts",
  "config.ts",
  "data-sink.ts",
  "device-capabilities.ts",
  "diagnostics.ts",
  "durability.ts",
  "env.d.ts",
  "envelope.ts",
  "foreground-recovery.ts",
  "inspector.ts",
  "lifecycle.ts",
  "live-query-store.ts",
  "mod.ts",
  "mutation-taxonomy.ts",
  "namespace-state.ts",
  "passkey-recovery.ts",
  "pop.ts",
  "probe.ts",
  "provision.ts",
  "pwa.ts",
  "recovery.ts",
  "resource-lifecycle.ts",
  "runtime.ts",
  "schema-compat.ts",
  "session.ts",
  "shared-field-keys.ts",
  "shared-field-write.ts",
  "startup-recovery.ts",
  "storage-fork.ts",
  "store-status.ts",
  "table-mutations.ts",
  "table-store.ts",
  "transport-gate.ts",
  "ui-mutation.ts",
  "upgrade-coordination.ts",
  "write-handle.ts",
  "write-journal.ts",
  "write-ledger.ts",
] as const;

/** Access modules vendored into `.lofi/`; kept in lockstep by the manifest test. */
export const accessFiles = [
  "errors.ts",
  "identity.ts",
  "mod.ts",
  "operations.ts",
  "policies.ts",
  "schema.ts",
  "shared-field-lifecycle.ts",
] as const;

/** Schema facade modules vendored into `.lofi/`; kept in lockstep by the manifest test. */
export const schemaFiles = [
  "compat.ts",
  "effects.ts",
  "encrypted.ts",
  "mod.ts",
  "nested.ts",
  "padding.ts",
  "private-table.ts",
  "shared-crypto.ts",
  "shared-encrypted.ts",
  "shared-keyring.ts",
  "shared-registry.ts",
  "store.ts",
] as const;

/** Preact modules vendored into `.lofi/`; kept in lockstep by the manifest test. */
export const preactFiles = [
  "DeviceStatus.tsx",
  "live-data.ts",
  "mod.ts",
  "PwaActions.tsx",
  "RuntimeRecovery.tsx",
  "TicketEnrollForm.tsx",
  "use-boot-progress.ts",
  "use-device-capabilities.ts",
  "use-schema-compat.ts",
  "use-storage-fork.ts",
  "write-hooks.ts",
] as const;

/** Recipe modules vendored into `.lofi/`; kept in lockstep by the manifest test. */
export const recipeFiles = [
  "file-handler.ts",
  "launch-handler.ts",
  "protocol-handler.ts",
  "related-app-discovery.ts",
  "scope-extension.ts",
  "web-share.ts",
  "window-controls-overlay.ts",
] as const;
