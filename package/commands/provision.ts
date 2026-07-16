#!/usr/bin/env -S deno run -A

/**
 * The `deno task jazz:provision` command: generates a managed Jazz app and
 * writes its configuration into `.env`, so the project can offer synced,
 * backed-up accounts. Prints the new app id and how to claim it — never the
 * secrets, which live only in the git-ignored `.env`.
 *
 * @module
 */

import {
  JAZZ_CLAIM_WINDOW_DAYS,
  JAZZ_DASHBOARD_URL,
  ProvisionError,
  provisionJazzApp,
} from "../tooling/provision.ts";

function parseArgs(args: string[]): { path: string; force: boolean } {
  let path = ".env";
  let force = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--force") force = true;
    else if (arg === "--env") {
      const value = args[++index];
      if (!value) {
        console.error("usage: deno task jazz:provision [--env <path>] [--force]");
        Deno.exit(2);
      }
      path = value;
    } else {
      console.error(`error: unknown argument ${JSON.stringify(arg)}`);
      console.error("usage: deno task jazz:provision [--env <path>] [--force]");
      Deno.exit(2);
    }
  }
  return { path, force };
}

const { path, force } = parseArgs(Deno.args);

try {
  const result = await provisionJazzApp({ path, force });
  console.log(`Provisioned Jazz app ${result.app.appId}`);
  console.log(`  Sync server: ${result.serverUrl}`);
  console.log(
    `  ${
      result.replaced ? "Replaced" : "Wrote"
    } JAZZ_APP_ID / JAZZ_SERVER_URL / JAZZ_ADMIN_SECRET / BACKEND_SECRET in ${result.path}`,
  );
  console.log("");
  console.log(
    `Claim this app within ${JAZZ_CLAIM_WINDOW_DAYS} days at ${JAZZ_DASHBOARD_URL} (use the admin`,
  );
  console.log(
    `secret saved in ${result.path}); unclaimed apps expire. Keep ${result.path} private`,
  );
  console.log("— it holds server-only secrets and is already git-ignored.");
} catch (error) {
  if (error instanceof ProvisionError) {
    console.error(`error: ${error.message}`);
    Deno.exit(1);
  }
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  Deno.exit(1);
}
