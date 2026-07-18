import { extname, join, relative, resolve } from "node:path";
import { expectedPrecacheUrls, sourcePwaIssues } from "./pwa-validation.ts";

const ignoredDirectories = new Set([
  ".astro",
  ".git",
  ".lofi",
  ".playwright-cli",
  ".vite",
  "coverage",
  "node_modules",
  "playwright-report",
  "test-results",
]);

export type ProjectCheck = {
  name: string;
  status: "ok" | "blocker";
  detail: string;
  remediation?: string;
};

export async function projectChecks(
  root = Deno.cwd(),
  deploymentBase = "/",
): Promise<ProjectCheck[]> {
  // The generic local-first scaffold every lofi project carries, independent of
  // the app's domain. Islands, schema tables, and stores are author content and
  // are intentionally not required here — a project stays valid after the starter
  // example is replaced.
  const required = [
    "deno.json",
    "src/schema.ts",
    "src/permissions.ts",
    "src/app.ts",
    "src/pages/index.astro",
    "src/layouts/Shell.astro",
    "public/manifest.webmanifest",
  ];
  const missing: string[] = [];
  for (const path of required) {
    try {
      if (!(await Deno.stat(join(root, path))).isFile) missing.push(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) missing.push(path);
      else throw error;
    }
  }
  if (missing.length > 0) {
    return [{
      name: "Project",
      status: "blocker",
      detail: `missing ${missing.join(", ")}`,
      remediation: "restore the generated files or create a fresh project and move author files",
    }];
  }
  const pwaIssues = await sourcePwaIssues(root, deploymentBase);
  return [
    { name: "Project", status: "ok", detail: "generated layout complete" },
    ...(pwaIssues.length === 0
      ? [{
        name: "PWA source",
        status: "ok" as const,
        detail: "manifest and assets are installable",
      }]
      : pwaIssues.map((pwaIssue) => ({
        name: "PWA source",
        status: "blocker" as const,
        detail: pwaIssue.detail,
        remediation: pwaIssue.remediation,
      }))),
  ];
}

export async function walkFiles(
  root = Deno.cwd(),
  options: { includeDist?: boolean; extensions?: ReadonlySet<string> } = {},
): Promise<string[]> {
  const absoluteRoot = resolve(root);
  const files: string[] = [];
  async function visit(path: string) {
    const entries = [...Deno.readDirSync(path)].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (
        entry.name === ".env" || (entry.name.startsWith(".env.") && entry.name !== ".env.example")
      ) {
        continue;
      }
      if (entry.isDirectory) {
        if (ignoredDirectories.has(entry.name) && !(entry.name === "dist" && options.includeDist)) {
          continue;
        }
        await visit(join(path, entry.name));
      } else if (entry.isFile) {
        if (!options.extensions || options.extensions.has(extname(child))) {
          files.push(relative(absoluteRoot, child));
        }
      } else {
        throw new Error(
          `project contains unsupported symbolic link: ${relative(absoluteRoot, child)}; ` +
            "replace it with a regular file or directory, then rerun the command",
        );
      }
    }
  }
  await visit(absoluteRoot);
  return files.sort();
}

export async function sourceFingerprint(root = Deno.cwd()): Promise<string> {
  const files = await walkFiles(root, {
    extensions: new Set([
      ".astro",
      ".css",
      ".js",
      ".json",
      ".png",
      ".svg",
      ".ts",
      ".tsx",
      ".webmanifest",
    ]),
  });
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (const path of files) {
    const header = encoder.encode(`${path}\0`);
    const content = await Deno.readFile(join(root, path));
    chunks.push(header, content);
    length += header.length + content.length;
  }
  const input = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function precacheUrls(
  paths: readonly string[],
  presentationPaths: readonly string[] = [],
): string[] {
  return expectedPrecacheUrls(paths, presentationPaths);
}

/**
 * Byte-identical groups among build-emitted assets (`_astro/`). The same
 * payload under two names means two build contexts disagreed on an asset
 * naming template, and every copy ships and precaches. User-authored files
 * outside `_astro/` are copied verbatim and are not the build's to judge.
 */
export async function duplicateBuildAssets(
  paths: readonly string[],
  root = "dist",
): Promise<string[][]> {
  const bySize = new Map<number, string[]>();
  for (const path of paths) {
    const portable = path.replaceAll("\\", "/");
    if (!portable.startsWith("_astro/")) continue;
    const { size } = await Deno.stat(join(root, path));
    bySize.set(size, [...(bySize.get(size) ?? []), portable]);
  }
  const groups: string[][] = [];
  for (const candidates of bySize.values()) {
    if (candidates.length < 2) continue;
    const byDigest = new Map<string, string[]>();
    for (const path of candidates) {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", await Deno.readFile(join(root, path))),
      );
      const key = Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      byDigest.set(key, [...(byDigest.get(key) ?? []), path]);
    }
    for (const group of byDigest.values()) {
      if (group.length > 1) groups.push(group.sort());
    }
  }
  return groups.sort((left, right) => left[0].localeCompare(right[0]));
}

/** Total bytes a fresh install downloads for the app shell (the precached set). */
export async function shellWeightBytes(
  paths: readonly string[],
  root = "dist",
): Promise<number> {
  let total = 0;
  for (const path of paths) total += (await Deno.stat(join(root, path))).size;
  return total;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  outer:
  for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
    for (let index = 0; index < needle.length; index++) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

export async function scanSecrets(
  secrets: Readonly<Record<string, string>>,
  root = Deno.cwd(),
): Promise<{ scanned: number; leaks: Array<{ name: string; path: string }> }> {
  const values = Object.entries(secrets).filter(([, value]) => value.trim().length > 0);
  const files = await walkFiles(root, { includeDist: true });
  const encoder = new TextEncoder();
  const leaks: Array<{ name: string; path: string }> = [];
  for (const path of files) {
    const content = await Deno.readFile(join(root, path));
    for (const [name, value] of values) {
      if (contains(content, encoder.encode(value))) leaks.push({ name, path });
    }
  }
  return { scanned: files.length, leaks };
}
