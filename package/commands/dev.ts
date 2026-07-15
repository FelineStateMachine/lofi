#!/usr/bin/env -S deno run -A

import { runDenoStatus } from "../tooling/process.ts";
import { validatedCommandEnvironment } from "./shared.ts";

const environment = await validatedCommandEnvironment();
environment.ASTRO_DEV_BACKGROUND = "1";

console.log("lofi dev");
console.log("Storage:     OPFS durable requested; browser gate required");
console.log("Persistence: pending browser check");
console.log("Identity:    device-local key; passkey backup blocked by alpha security review");
console.log(
  `Sync:        ${
    environment.JAZZ_APP_ID
      ? "managed configured; live connection detail unavailable"
      : "local-only"
  }`,
);
console.log("PWA:         development service worker disabled");
console.log("Device:      stable HTTPS URL not configured; device preview graduates in M3");

const forwarded = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
const status = await runDenoStatus(
  ["run", "-A", "npm:astro@7.0.9", "dev", ...forwarded],
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
