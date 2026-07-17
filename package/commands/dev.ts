#!/usr/bin/env -S deno run -A

/**
 * The `deno task dev` command: runs the Astro development server after lofi
 * preflight checks and diagnostics.
 *
 * @module
 */

import { relative } from "node:path";
import { runDenoStatus } from "../tooling/process.ts";
import { prepareLofiAstroConfig } from "../astro/mod.ts";
import { validatedCommandEnvironment } from "./shared.ts";

const environment = await validatedCommandEnvironment();
environment.ASTRO_DEV_BACKGROUND = "1";

console.log("lofi dev");
console.log("Storage:     OPFS durable requested; browser gate required");
console.log("Persistence: pending browser check");
console.log(
  "Identity:    local-first account; opens immediately, back up + sync via AccountGate",
);
console.log(
  `Sync:        ${
    environment.JAZZ_APP_ID
      ? "managed configured; users elect to back up and sync per account"
      : "local-only"
  }`,
);
console.log(`PWA:         development service worker disabled; base ${environment.LOFI_BASE_PATH}`);
console.log("Device:      stable HTTPS URL not configured; device preview graduates in M3");

const forwarded = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
const astroConfig = relative(Deno.cwd(), await prepareLofiAstroConfig());
const status = await runDenoStatus(
  ["run", "-A", "npm:astro@7.0.9", "dev", "--config", astroConfig, ...forwarded],
  environment,
);
if (status.forwardedSignal) {
  Deno.exit(0);
}
if (status.code !== 0) {
  console.error(
    "error: development server stopped; application impact: no local URL is available. Run `deno task doctor`, apply the first action, then rerun `deno task dev`.",
  );
  Deno.exit(status.code);
}
