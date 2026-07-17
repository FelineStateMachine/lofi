// Package-owned browser boot orchestration.
import { registerProductionServiceWorker } from "./pwa.ts";

let booted = false;

/** Starts lofi's browser lifecycle once for the current document. */
export async function bootLofi(): Promise<void> {
  if (booted || typeof document === "undefined") return;
  booted = true;
  await import("./lifecycle.ts");
  registerProductionServiceWorker();
  if (import.meta.env.DEV) void import("./probe.ts");
}
