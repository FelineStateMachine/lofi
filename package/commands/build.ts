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
import {
  duplicateBuildAssets,
  engineWasmAssets,
  engineWasmPreloadTag,
  heaviestShellAsset,
  injectHeadTags,
  precacheUrls,
  scanSecrets,
  shellWeightBytes,
  sourceFingerprint,
  walkFiles,
} from "../tooling/project.ts";
import {
  precachePaths,
  productionPwaIssues,
  screenshotAssetPaths,
} from "../tooling/pwa-validation.ts";
import { generateSchemaCompatManifest } from "../tooling/schema-manifest.ts";
import {
  cspPolicyWarnings,
  mergeCspPolicies,
  parseCspMeta,
  renderHeadersSnippet,
} from "../tooling/csp.ts";
import { runDeno } from "../tooling/process.ts";
import { exitOnFailure, validatedCommandEnvironment } from "./shared.ts";

// A fresh install downloads the whole precache, so every build reports the
// shell's weight, and an unusually heavy shell (the lofi runtime with the Jazz
// WASM engine accounts for ~10 MB of it) earns a warning. How much an app
// ships is the author's call — the warning is information, not a gate.
const shellWeightNoticeBytes = 20 * 1024 * 1024;

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

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
// The revision↔schema compatibility manifest. Written before the dist walk so
// it joins the precache: an offline shell must still know its own schema
// range for the boot compatibility gate.
let schemaManifest;
try {
  schemaManifest = await generateSchemaCompatManifest({ revision: sourceHash });
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  console.error(
    "error: the schema compatibility manifest could not be generated; fix src/schema.ts, then rerun `deno task build`",
  );
  Deno.exit(1);
}
await Deno.writeTextFile("dist/lofi-schema.json", `${JSON.stringify(schemaManifest)}\n`);
const productionManifest = JSON.parse(await Deno.readTextFile("dist/manifest.webmanifest"));
// One walk serves the precache manifest, the shell checks, and the route
// count below.
const distFiles = await walkFiles("dist", { includeDist: true });

// The engine binary dominates a cold first visit. Every prerendered page
// preloads it so the download overlaps the module graph instead of queueing
// behind it, and the tag carries the byte size the runtime's boot-progress
// surface reports while the download runs.
const engineTags = await Promise.all(
  engineWasmAssets(distFiles).map(async (asset) =>
    engineWasmPreloadTag(
      asset,
      environment.LOFI_BASE_PATH || "/",
      (await Deno.stat(join("dist", asset))).size,
    )
  ),
);
const cspPolicies: string[] = [];
const cspMissing: string[] = [];
for (const path of distFiles.filter((file) => extname(file) === ".html")) {
  const html = await Deno.readTextFile(join("dist", path));
  const injected = injectHeadTags(html, engineTags);
  if (injected !== html) await Deno.writeTextFile(join("dist", path), injected);
  const policy = parseCspMeta(injected);
  if (policy === null) cspMissing.push(path);
  else cspPolicies.push(policy);
}

// One deployable policy for the whole site: the per-page meta tags enforce
// it already; the union feeds the preview server's real header and the
// host-header snippet. Reported, never gated.
const cspUnion = cspPolicies.length > 0 ? mergeCspPolicies(cspPolicies) : null;
if (cspUnion !== null) {
  const buildInfo = JSON.parse(await Deno.readTextFile("dist/lofi-build.json"));
  buildInfo.csp = cspUnion;
  await Deno.writeTextFile("dist/lofi-build.json", `${JSON.stringify(buildInfo)}\n`);
  await Deno.writeTextFile("dist/_headers.example", renderHeadersSnippet(cspUnion));
  const hashCount = (cspUnion.match(/'sha\d{3}-/g) ?? []).length;
  console.log(
    `lofi build: CSP script-src 'self' 'wasm-unsafe-eval' + ${hashCount} hashes ` +
      "(meta-enforced; mirror as a header where your host supports it — see dist/_headers.example)",
  );
  for (const finding of cspPolicyWarnings(cspUnion)) console.warn(`warning: ${finding}`);
  if (cspMissing.length > 0) {
    console.warn(
      `warning: ${cspMissing.length} built page(s) carry no CSP meta tag: ${cspMissing.join(", ")}`,
    );
  }
} else {
  console.warn(
    "warning: the build carries no Content-Security-Policy (LOFI_CSP=off or no pages); " +
      "same-origin script is the threat model's shaping attacker, so prefer the default policy",
  );
}

const screenshotPaths = screenshotAssetPaths(productionManifest, environment.LOFI_BASE_PATH);
const shellPaths = precachePaths(distFiles, screenshotPaths);

const duplicateAssets = await duplicateBuildAssets(shellPaths);
if (duplicateAssets.length > 0) {
  for (const group of duplicateAssets) {
    console.error(`error: byte-identical build assets: ${group.join(", ")}`);
  }
  console.error(
    "error: two build contexts emitted the same payload under different names and every copy is precached; unify the asset naming, then rerun `deno task build`",
  );
  Deno.exit(1);
}

const shellBytes = await shellWeightBytes(shellPaths);
const heaviestAsset = await heaviestShellAsset(shellPaths);
if (shellBytes > shellWeightNoticeBytes) {
  console.warn(
    `warning: the app shell weighs ${
      megabytes(shellBytes)
    } MB; a fresh install downloads every precached byte, so heavy assets may belong outside the precache (served on demand instead)`,
  );
}

const precache = precacheUrls(distFiles, screenshotPaths);
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
  `lofi build: ${join(Deno.cwd(), "dist")} (${routes} routes, ${sourceHash}, ${
    megabytes(shellBytes)
  } MB shell${
    heaviestAsset
      ? `, heaviest asset ${heaviestAsset.path} at ${megabytes(heaviestAsset.bytes)} MB`
      : ""
  }, secret scan passed)`,
);
