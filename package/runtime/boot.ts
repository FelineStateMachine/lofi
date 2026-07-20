/// <reference path="./env.d.ts" />
// Package-owned browser boot orchestration.
import { getLofiApp } from "./app.ts";
import { ensureDeclaredSinkRestored } from "./data-sink.ts";
import {
  attachPwaUpdateCoordination,
  registerProductionServiceWorker,
  resolvePwaResources,
} from "./pwa.ts";
import { mountDefaultCompatBanner, schemaCompatGate } from "./schema-compat.ts";
import { mountDefaultForkNotice, storageForkGuard } from "./storage-fork.ts";
import { configureUpgradeCoordinator } from "./upgrade-coordination.ts";

let booted = false;

// The compatibility gate and the cross-tab upgrade coordination are wired
// before the runtime opens: the gate's verdict must be able to refuse the
// first write, and sibling tabs must hear an upgrade announcement no matter
// which module triggers it.
function startCompatibilityGate(): void {
  schemaCompatGate.start();
  mountDefaultCompatBanner();
  if (!import.meta.env.PROD) return;
  const deploymentBaseUrl = new URL(import.meta.env.BASE_URL, document.location.origin).href;
  const coordinator = configureUpgradeCoordinator(resolvePwaResources(deploymentBaseUrl).scope);
  attachPwaUpdateCoordination({
    prepareUpdateSwap: () => coordinator.announceUpgrade(),
    staleTabBehavior: () => {
      try {
        return getLofiApp().pwa?.staleTabs ?? "reload";
      } catch {
        return "reload";
      }
    },
    onStaleTab: () => {
      // The swap this tab sat out is over; resume writes long enough for the
      // gate to flip the tab read-only with its reload prompt.
      coordinator.notifyActivation();
      schemaCompatGate.markStaleTab();
    },
  });
}

/**
 * Starts lofi's browser lifecycle once for the current document.
 *
 * Import the module that calls `defineLofiApp` first so the runtime can resolve
 * the app definition. Safe to call more than once; later calls are no-ops.
 *
 * @example
 * ```ts
 * import { bootLofi } from "@nzip/lofi";
 * // Importing app.ts registers defineLofiApp before the runtime boots.
 * import { app } from "../app.ts";
 *
 * void app;
 * void bootLofi();
 * ```
 *
 * @returns A promise that resolves once boot has been scheduled for this document.
 */
export async function bootLofi(): Promise<void> {
  if (booted || typeof document === "undefined") return;
  booted = true;
  // The fork guard snapshots container freshness from localStorage, so it
  // must run before any other module stores a key there.
  storageForkGuard.start();
  mountDefaultForkNotice();
  // The sink envelope must be open before lifecycle.ts reads the sync
  // location at import time. A restore failure degrades to local-only; it
  // must never brick boot.
  await ensureDeclaredSinkRestored();
  startCompatibilityGate();
  await import("./lifecycle.ts");
  // Arm the write ledger so journaled writes reconcile and outstanding effect
  // obligations re-run before any island mounts. A boot that cannot open the
  // runtime surfaces through its own diagnostics, never through arming.
  void import("./write-ledger.ts")
    .then((ledger) => ledger.armWriteLedger())
    .catch(() => undefined);
  registerProductionServiceWorker();
  if (import.meta.env.DEV) void import("./probe.ts");
}
