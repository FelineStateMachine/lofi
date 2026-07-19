#!/usr/bin/env -S deno run -A

/**
 * Applies the demo overlay (apps/demo/overlay) onto a generated lofi app.
 *
 * Every overlay file replaces its counterpart in the generated project; a file
 * with no counterpart is an error unless it is listed in {@link NEW_FILES}.
 * Text files may carry the `__LOFI_DEMO_VERSION__` placeholder, which is
 * replaced with the released package version.
 *
 * Usage: deno run -A tools/demo_overlay.ts --app <path> [--version <semver>]
 */

import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOFI_VERSION } from "../package/version.ts";

/** Overlay files that intentionally have no counterpart in the starter. */
export const NEW_FILES: readonly string[] = [
  "src/islands/IncidentBoard.tsx",
  "src/islands/MagmaBackdrop.tsx",
  "src/islands/StatusStrip.tsx",
  "src/islands/use-incidents.ts",
  "public/fonts/chakra-petch-700.woff2",
  "public/fonts/OFL.txt",
];

/** The placeholder substituted with the released version. */
export const VERSION_PLACEHOLDER = "__LOFI_DEMO_VERSION__";

const TEXT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".astro",
  ".css",
  ".json",
  ".webmanifest",
  ".svg",
  ".md",
];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The overlay source directory, resolved from the repository checkout. */
export const OVERLAY_ROOT = join(repositoryRoot, "apps", "demo", "overlay");

function isTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** Lists overlay file paths relative to the overlay root, sorted. */
export async function listOverlayFiles(root: string = OVERLAY_ROOT): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile) files.push(relative(root, path));
    }
  }
  await walk(root);
  return files.sort();
}

/** Copies the overlay onto the generated app and substitutes the version. */
export async function applyOverlay(appDirectory: string, version: string): Promise<string[]> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`--version must be an exact semantic version, got ${JSON.stringify(version)}`);
  }
  const appRoot = resolve(appDirectory);
  const appStat = await Deno.stat(appRoot).catch(() => null);
  if (appStat === null || !appStat.isDirectory) {
    throw new Error(`generated app directory not found: ${appRoot}`);
  }

  const overlayFiles = await listOverlayFiles();
  if (overlayFiles.length === 0) throw new Error(`overlay is empty: ${OVERLAY_ROOT}`);

  for (const relativePath of overlayFiles) {
    const target = join(appRoot, relativePath);
    const counterpart = await Deno.stat(target).catch(() => null);
    if (counterpart === null && !NEW_FILES.includes(relativePath)) {
      throw new Error(
        `overlay file ${relativePath} has no counterpart in the generated app; ` +
          `the starter layout changed, or the file belongs in NEW_FILES`,
      );
    }
    await Deno.mkdir(dirname(target), { recursive: true });
    const source = join(OVERLAY_ROOT, relativePath);
    if (isTextFile(relativePath)) {
      const contents = await Deno.readTextFile(source);
      await Deno.writeTextFile(target, contents.replaceAll(VERSION_PLACEHOLDER, version));
    } else {
      const bytes = await Deno.readFile(source);
      if (new TextDecoder("utf-8", { fatal: false }).decode(bytes).includes(VERSION_PLACEHOLDER)) {
        throw new Error(
          `overlay file ${relativePath} carries the version placeholder ` +
            `but is not recognized as a text file, so it would ship unsubstituted`,
        );
      }
      await Deno.writeFile(target, bytes);
    }
  }
  return overlayFiles;
}

if (import.meta.main) {
  let appDirectory = "";
  let version = LOFI_VERSION;
  const args = [...Deno.args];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--app") appDirectory = args[++index] ?? "";
    else if (argument === "--version") version = args[++index] ?? "";
    else throw new Error(`unknown demo-overlay argument ${JSON.stringify(argument)}`);
  }
  if (appDirectory === "") throw new Error("--app <path to generated app> is required");
  const applied = await applyOverlay(appDirectory, version);
  console.log(`applied ${applied.length} overlay files onto ${resolve(appDirectory)}:`);
  for (const path of applied) console.log(`  ${path}`);
}
