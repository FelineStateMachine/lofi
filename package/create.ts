#!/usr/bin/env -S deno run -A

/**
 * The `deno run -A jsr:@nzip/lofi/create <name>` command: scaffolds a new
 * local-first PWA project from the validated starter template. Pass `--sync` to
 * also provision a managed Jazz app and write it into the project's `.env`, so
 * the app can offer synced, backed-up accounts from the first boot.
 *
 * @module
 */

import { join } from "node:path";
import { createProject } from "./create_core.ts";
import {
  JAZZ_CLAIM_WINDOW_DAYS,
  JAZZ_DASHBOARD_URL,
  ProvisionError,
  provisionJazzApp,
} from "./tooling/provision.ts";

function usage(): never {
  console.error("usage: deno run -A jsr:@nzip/lofi/create [--sync] <name>");
  Deno.exit(2);
}

function parseArgs(args: string[]): { name: string; sync: boolean } {
  let name: string | undefined;
  let sync = false;
  for (const arg of args) {
    if (arg === "--sync") sync = true;
    else if (arg.startsWith("-")) usage();
    else if (name === undefined) name = arg;
    else usage();
  }
  if (name === undefined) usage();
  return { name, sync };
}

const { name, sync } = parseArgs(Deno.args);

try {
  const developmentPrefix = Deno.env.get("LOFI_CREATE_DEVELOPMENT") === "1"
    ? Deno.env.get("LOFI_CREATE_PACKAGE_PREFIX")
    : undefined;
  if (
    developmentPrefix &&
    (!developmentPrefix.startsWith("file:") || !developmentPrefix.endsWith("/"))
  ) {
    throw new Error("internal development package prefix must be a trailing-slash file URL");
  }
  const result = await createProject({
    cwd: Deno.cwd(),
    name,
    packagePrefix: developmentPrefix,
  });
  console.log(`Created ${result.displayPath}`);

  if (sync) {
    console.log("");
    console.log("Provisioning a managed Jazz app for sync…");
    const provisioned = await provisionJazzApp({ path: join(result.destination, ".env") });
    console.log(`  Jazz app ${provisioned.app.appId} → wrote .env`);
    console.log(
      `  Claim it within ${JAZZ_CLAIM_WINDOW_DAYS} days at ${JAZZ_DASHBOARD_URL} (admin secret is in .env); unclaimed apps expire.`,
    );
  }

  console.log("");
  console.log("Next:");
  for (const command of result.nextCommands) console.log(`  ${command}`);
} catch (error) {
  if (error instanceof ProvisionError) {
    console.error(`error: project created, but sync provisioning failed: ${error.message}`);
    console.error("Run `deno task jazz:provision` from the project once resolved.");
    Deno.exit(1);
  }
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  Deno.exit(1);
}
