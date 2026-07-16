import { extname, join, relative, resolve } from "node:path";

const ignoredDirectories = new Set([
  ".astro",
  ".git",
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

export async function projectChecks(root = Deno.cwd()): Promise<ProjectCheck[]> {
  const required = [
    "deno.json",
    "astro.config.ts",
    "src/schema.ts",
    "src/permissions.ts",
    "src/app.ts",
    "src/pages/index.astro",
    "src/islands/ChecklistIsland.tsx",
    "src/_lofi/boot.ts",
    "public/manifest.webmanifest",
    "public/sw.js",
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
  return missing.length === 0
    ? [{ name: "Project", status: "ok", detail: "generated layout complete" }]
    : [{
      name: "Project",
      status: "blocker",
      detail: `missing ${missing.join(", ")}`,
      remediation: "restore the generated files or create a fresh project and move author files",
    }];
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

const precacheExcludedPaths = new Set([
  "lofi-build.json",
  "lofi-precache.json",
  "sw.js",
]);

export function precacheUrls(paths: readonly string[]): string[] {
  return paths
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !precacheExcludedPaths.has(path))
    .map((path) => path === "index.html" ? "./" : `./${path}`)
    .sort();
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
