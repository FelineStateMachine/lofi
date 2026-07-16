/**
 * Every source-controlled file copied from the validated reference app into a
 * new project, by its path relative to both the reference app and the generated
 * project. The contents are read at runtime (see {@link readStarterFile}) rather
 * than imported with `type: "text"`, which JSR does not support when publishing.
 */
export const STARTER_FILES: readonly string[] = [
  "deno.json",
  "astro.config.ts",
  "tsconfig.json",
  "public/favicon.svg",
  "public/manifest.webmanifest",
  "public/sw.js",
  "src/app.ts",
  "src/env.d.ts",
  "src/permissions.ts",
  "src/schema.ts",
  "src/pages/index.astro",
  "src/styles/global.css",
  "src/islands/TaskList.tsx",
  "src/islands/use-tasks.ts",
  "src/_lofi/DeviceStatus.tsx",
  "src/_lofi/Shell.astro",
  "src/_lofi/boot.ts",
  "src/_lofi/config.ts",
  "src/_lofi/diagnostics.ts",
  "src/_lofi/device-capabilities.ts",
  "src/_lofi/device-capabilities_test.ts",
  "src/_lofi/inspector.ts",
  "src/_lofi/inspector_test.ts",
  "src/_lofi/probe.ts",
  "src/_lofi/pwa.ts",
  "src/_lofi/pwa_test.ts",
  "src/_lofi/resource-lifecycle.ts",
  "src/_lofi/resource-lifecycle_test.ts",
  "src/_lofi/runtime.ts",
  "src/_lofi/table-store.ts",
  "src/_lofi/table-store_test.ts",
  "src/_lofi/test-assert.ts",
  "src/_lofi/ui-mutation.ts",
  "src/_lofi/ui-mutation_test.ts",
  "src/_lofi/use-device-capabilities.ts",
  "tests/author-boundary_test.ts",
  "tests/convergence_e2e_test.ts",
  "tests/testing-contract_test.ts",
];

/**
 * Reads a starter file's contents, resolving it relative to the reference app.
 * Works both from a source checkout (a `file:` URL read from disk) and from the
 * published package (an `https:` JSR URL fetched over the network).
 */
export async function readStarterFile(relativePath: string): Promise<string> {
  const url = import.meta.resolve(`../apps/reference/${relativePath}`);
  if (url.startsWith("file:")) return await Deno.readTextFile(new URL(url));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to read starter file ${relativePath}: HTTP ${response.status}`);
  }
  return await response.text();
}
