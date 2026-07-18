#!/usr/bin/env -S deno run -A

/**
 * The `deno task build` command: builds the static PWA into `dist/` with a
 * source-hash build id, a service-worker precache manifest, and a scan that
 * fails the build if server secrets leak into client output.
 *
 * @module
 */

import { extname, join, relative } from "node:path";
import { LOFI_VERSION } from "../version.ts";
import { prepareLofiAstroConfig } from "../astro/mod.ts";
import { loadEnvironment, serverEnvironmentNames } from "../tooling/environment.ts";
import { precacheUrls, scanSecrets, sourceFingerprint, walkFiles } from "../tooling/project.ts";
import { productionPwaIssues, screenshotAssetPaths } from "../tooling/pwa-validation.ts";
import { runDeno } from "../tooling/process.ts";
import { exitOnFailure, validatedCommandEnvironment } from "./shared.ts";

const environment = await validatedCommandEnvironment();
environment.LOFI_SKIP_JAZZ_MANAGED = "1";
environment.JAZZ_ADMIN_SECRET = "";
environment.BACKEND_SECRET = "";
const sourceHash = (await sourceFingerprint()).slice(0, 12);
const astroConfig = relative(Deno.cwd(), await prepareLofiAstroConfig());

async function readPackageAsset(path: string): Promise<string> {
  const url = new URL(path, import.meta.url);
  if (url.protocol === "file:") return await Deno.readTextFile(url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to read package asset ${path}: HTTP ${response.status}`);
  }
  return await response.text();
}

exitOnFailure(
  await runDeno(
    ["run", "-A", "npm:astro@7.0.9", "build", "--config", astroConfig],
    environment,
  ),
  "production build",
);

await Deno.writeTextFile(
  "dist/lofi-build.json",
  `${
    JSON.stringify({
      lofiVersion: LOFI_VERSION,
      sourceHash,
      basePath: environment.LOFI_BASE_PATH,
      builtAt: new Date().toISOString(),
    })
  }\n`,
);
const serviceWorkerPath = "dist/sw.js";
const serviceWorker = await readPackageAsset("../runtime/sw.js");
await Deno.writeTextFile(
  serviceWorkerPath,
  serviceWorker.replace("__LOFI_BUILD_REVISION__", sourceHash),
);
const productionManifest = JSON.parse(await Deno.readTextFile("dist/manifest.webmanifest"));
// One walk serves both the precache manifest and the route count below.
const distFiles = await walkFiles("dist", { includeDist: true });
const precache = precacheUrls(
  distFiles,
  screenshotAssetPaths(productionManifest, environment.LOFI_BASE_PATH),
);
await Deno.writeTextFile("dist/lofi-precache.json", `${JSON.stringify(precache.sort())}\n`);

const pwaIssues = await productionPwaIssues(Deno.cwd(), environment.LOFI_BASE_PATH);
if (pwaIssues.length > 0) {
  for (const pwaIssue of pwaIssues) console.error(`error: ${pwaIssue.detail}`);
  console.error(`error: ${pwaIssues[0].remediation}`);
  Deno.exit(1);
}

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

const routes = distFiles.filter((path) => extname(path) === ".html").length;
console.log(
  `lofi build: ${join(Deno.cwd(), "dist")} (${routes} routes, ${sourceHash}, secret scan passed)`,
);
