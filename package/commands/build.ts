#!/usr/bin/env -S deno run -A

/**
 * The `deno task build` command: builds the static PWA into `dist/` with a
 * source-hash build id, a service-worker precache manifest, and a scan that
 * fails the build if server secrets leak into client output.
 *
 * @module
 */

import { extname, join } from "node:path";
import { LOFI_VERSION } from "../version.ts";
import { loadEnvironment, serverEnvironmentNames } from "../tooling/environment.ts";
import { precacheUrls, scanSecrets, sourceFingerprint, walkFiles } from "../tooling/project.ts";
import { runDeno } from "../tooling/process.ts";
import { exitOnFailure, validatedCommandEnvironment } from "./shared.ts";

const environment = await validatedCommandEnvironment();
environment.LOFI_SKIP_JAZZ_MANAGED = "1";
environment.JAZZ_ADMIN_SECRET = "";
environment.BACKEND_SECRET = "";
const sourceHash = (await sourceFingerprint()).slice(0, 12);

exitOnFailure(
  await runDeno(["run", "-A", "npm:astro@7.0.9", "build"], environment),
  "production build",
);

await Deno.writeTextFile(
  "dist/lofi-build.json",
  `${
    JSON.stringify({ lofiVersion: LOFI_VERSION, sourceHash, builtAt: new Date().toISOString() })
  }\n`,
);
const serviceWorkerPath = "dist/sw.js";
const serviceWorker = await Deno.readTextFile(serviceWorkerPath);
await Deno.writeTextFile(
  serviceWorkerPath,
  serviceWorker.replace("__LOFI_BUILD_REVISION__", sourceHash),
);
const precache = precacheUrls(await walkFiles("dist", { includeDist: true }));
await Deno.writeTextFile("dist/lofi-precache.json", `${JSON.stringify(precache.sort())}\n`);

const loadedEnvironment = await loadEnvironment();
const serverSecrets = Object.fromEntries(
  serverEnvironmentNames.map((name) => [name, loadedEnvironment[name] ?? ""]),
);
const secretResult = await scanSecrets(serverSecrets);
if (secretResult.leaks.length > 0) {
  for (const leak of secretResult.leaks) {
    console.error(`error: ${leak.name} value found in ${leak.path}`);
  }
  console.error(
    "error: build output may expose a server secret; remove it and rerun `deno task build`",
  );
  Deno.exit(1);
}

const routes = (await walkFiles("dist", { includeDist: true }))
  .filter((path) => extname(path) === ".html").length;
console.log(
  `lofi build: ${join(Deno.cwd(), "dist")} (${routes} routes, ${sourceHash}, secret scan passed)`,
);
