/**
 * Every source-controlled file copied from the validated reference app into a
 * new project, by its path relative to both the reference app and the generated
 * project. The contents are read at runtime (see {@link readStarterFile}) rather
 * than imported with `type: "text"`, which JSR does not support when publishing.
 */
export const STARTER_FILES: readonly string[] = [
  "deno.json",
  "tsconfig.json",
  "public/favicon.svg",
  "public/apple-touch-icon.png",
  "public/icon-192.png",
  "public/icon-512.png",
  "public/icon-maskable-512.png",
  "public/icon-monochrome.svg",
  "public/screenshot-narrow.png",
  "public/screenshot-wide.png",
  "public/manifest.webmanifest",
  "src/app.ts",
  "src/env.d.ts",
  "src/permissions.ts",
  "src/schema.ts",
  "src/pages/index.astro",
  "src/styles/global.css",
  "src/islands/AccountGate.tsx",
  "src/islands/TaskList.tsx",
  "src/islands/use-tasks.ts",
  "src/layouts/Shell.astro",
  "tests/auth_e2e_test.ts",
  "tests/author-boundary_test.ts",
  "tests/backup_migration_e2e_test.ts",
  "tests/convergence_e2e_test.ts",
  "tests/testing-contract_test.ts",
];

/**
 * TypeScript starter files are read from a verbatim `.txt` mirror under
 * `package/starter/` instead of the reference app itself. Publishing rewrites
 * the specifiers inside every module in the package — which would hand
 * generated projects direct `jsr:`/`npm:` imports that bypass their pinned
 * import map and break their formatting — but leaves non-module files alone.
 * The mirror is kept byte-identical to the reference app by
 * `create_core_test.ts`.
 */
function starterFileUrl(relativePath: string): URL {
  if (/\.tsx?$/.test(relativePath)) {
    return new URL(`./starter/${relativePath}.txt`, import.meta.url);
  }
  return new URL(`../apps/reference/${relativePath}`, import.meta.url);
}

/**
 * Reads a starter file's contents, resolving it relative to the reference app.
 * Works both from a source checkout (a `file:` URL read from disk) and from the
 * published package (an `https:` JSR URL fetched over the network).
 */
export async function readStarterFile(relativePath: string): Promise<Uint8Array> {
  const url = starterFileUrl(relativePath);
  if (url.protocol === "file:") return await Deno.readFile(url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to read starter file ${relativePath}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
