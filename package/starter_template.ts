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
  "tests/convergence_e2e_test.ts",
  "tests/testing-contract_test.ts",
];

/**
 * Reads a starter file's contents, resolving it relative to the reference app.
 * Works both from a source checkout (a `file:` URL read from disk) and from the
 * published package (an `https:` JSR URL fetched over the network).
 */
export async function readStarterFile(relativePath: string): Promise<Uint8Array> {
  const url = new URL(`../apps/reference/${relativePath}`, import.meta.url);
  if (url.protocol === "file:") return await Deno.readFile(url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to read starter file ${relativePath}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
