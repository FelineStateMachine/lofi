#!/usr/bin/env -S deno run -A

import { extname, join } from "node:path";
import { LOFI_VERSION } from "../version.ts";
import { precacheUrls, sourceFingerprint, walkFiles } from "../tooling/project.ts";
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

const routes = (await walkFiles("dist", { includeDist: true }))
  .filter((path) => extname(path) === ".html").length;
console.log(
  `lofi build: ${join(Deno.cwd(), "dist")} (${routes} routes, ${sourceHash})`,
);
