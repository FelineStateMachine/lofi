// Package-owned browser boot orchestration.
import { restoreDeclaredSink } from "./data-sink.ts";
import { registerProductionServiceWorker } from "./pwa.ts";

let booted = false;

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
  // The sink envelope must be open before lifecycle.ts reads the sync
  // location at import time. A restore failure degrades to local-only; it
  // must never brick boot.
  try {
    await restoreDeclaredSink();
  } catch {
    // Continue local-only; enrollment can re-declare the sink.
  }
  await import("./lifecycle.ts");
  registerProductionServiceWorker();
  if (import.meta.env.DEV) void import("./probe.ts");
}
