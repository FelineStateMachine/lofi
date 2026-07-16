import "./lifecycle.ts";
import { registerProductionServiceWorker } from "./pwa.ts";

if (typeof document !== "undefined") {
  registerProductionServiceWorker();
  if (import.meta.env.DEV) void import("./probe.ts");
}
