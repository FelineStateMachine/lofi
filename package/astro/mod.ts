/**
 * Astro and Vite integration used by generated lofi applications.
 *
 * {@link prepareLofiAstroConfig} materializes version-matched runtime aliases
 * and Jazz configuration into the ignored `.lofi/` directory.
 *
 * @module
 */

import { join, resolve } from "node:path";

/** Options for materializing the package-owned Astro configuration. */
export type LofiAstroOptions = {
  /** Project root. Defaults to the directory from which Astro was invoked. */
  root?: string;
  /** Directory containing the Jazz schema and permissions. */
  schemaDir?: string;
};

/**
 * Runtime modules vendored into a project's `.lofi/` directory. Static because
 * the published package cannot list directories over JSR; the manifest test
 * fails when this list and `package/runtime/` drift apart.
 */
export const runtimeFiles = [
  "app.ts",
  "auth.ts",
  "boot.ts",
  "config.ts",
  "device-capabilities.ts",
  "diagnostics.ts",
  "env.d.ts",
  "foreground-recovery.ts",
  "inspector.ts",
  "lifecycle.ts",
  "live-query-store.ts",
  "mod.ts",
  "namespace-state.ts",
  "passkey-recovery.ts",
  "probe.ts",
  "pwa.ts",
  "recovery.ts",
  "resource-lifecycle.ts",
  "runtime.ts",
  "session.ts",
  "startup-recovery.ts",
  "table-mutations.ts",
  "table-store.ts",
  "transport-gate.ts",
  "ui-mutation.ts",
] as const;

/** Access modules vendored into `.lofi/`; kept in lockstep by the manifest test. */
export const accessFiles = [
  "errors.ts",
  "identity.ts",
  "mod.ts",
  "operations.ts",
  "policies.ts",
  "schema.ts",
] as const;

/** Preact modules vendored into `.lofi/`; kept in lockstep by the manifest test. */
export const preactFiles = [
  "DeviceStatus.tsx",
  "live-data.ts",
  "mod.ts",
  "PwaActions.tsx",
  "RuntimeRecovery.tsx",
  "use-device-capabilities.ts",
] as const;

/** Recipe modules vendored into `.lofi/`; kept in lockstep by the manifest test. */
export const recipeFiles = [
  "file-handler.ts",
  "launch-handler.ts",
  "protocol-handler.ts",
  "related-app-discovery.ts",
  "scope-extension.ts",
  "web-share.ts",
  "window-controls-overlay.ts",
] as const;

async function readPackageFile(path: string): Promise<string> {
  const url = new URL(path, import.meta.url);
  if (url.protocol === "file:") return await Deno.readTextFile(url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to read package module ${path}: HTTP ${response.status}`);
  }
  return await response.text();
}

function renderConfig(projectRoot: string): string {
  const runtimeEntry = join(projectRoot, ".lofi", "package", "runtime", "mod.ts");
  const accessEntry = join(projectRoot, ".lofi", "package", "access", "mod.ts");
  const preactEntry = join(projectRoot, ".lofi", "package", "preact", "mod.ts");
  const fileHandlerRecipe = join(projectRoot, ".lofi", "package", "recipes", "file-handler.ts");
  const launchHandlerRecipe = join(
    projectRoot,
    ".lofi",
    "package",
    "recipes",
    "launch-handler.ts",
  );
  const protocolHandlerRecipe = join(
    projectRoot,
    ".lofi",
    "package",
    "recipes",
    "protocol-handler.ts",
  );
  const relatedAppDiscoveryRecipe = join(
    projectRoot,
    ".lofi",
    "package",
    "recipes",
    "related-app-discovery.ts",
  );
  const scopeExtensionRecipe = join(
    projectRoot,
    ".lofi",
    "package",
    "recipes",
    "scope-extension.ts",
  );
  const webShareRecipe = join(projectRoot, ".lofi", "package", "recipes", "web-share.ts");
  const windowControlsOverlayRecipe = join(
    projectRoot,
    ".lofi",
    "package",
    "recipes",
    "window-controls-overlay.ts",
  );
  return `import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";
import { jazzPlugin } from "jazz-tools/dev/vite";
import { resolve } from "node:path";

const projectRoot = Deno.cwd();
const schemaDir = resolve(projectRoot, "src");
const cloudAppId = process.env.JAZZ_APP_ID?.trim();
const cloudServerUrl = process.env.JAZZ_SERVER_URL?.trim();
const managedJazzServer = process.env.LOFI_SKIP_JAZZ_MANAGED === "1"
  ? false
  : { allowLocalFirstAuth: true };
const deploymentBase = process.env.LOFI_BASE_PATH || "/";

if (Boolean(cloudAppId) !== Boolean(cloudServerUrl)) {
  throw new Error(
    "Cloud mode requires both JAZZ_APP_ID and JAZZ_SERVER_URL; set the missing name or remove the partial pair.",
  );
}

if (cloudAppId && cloudServerUrl) {
  process.env.VITE_JAZZ_APP_ID = cloudAppId;
  process.env.VITE_JAZZ_SERVER_URL = cloudServerUrl;
}

export default defineConfig({
  base: deploymentBase,
  output: "static",
  trailingSlash: "always",
  integrations: [preact({ compat: true, devtools: true })],
  vite: {
    plugins: [jazzPlugin({ schemaDir, inspector: false, server: managedJazzServer })],
    server: { fs: { allow: [projectRoot] } },
    define: {
      __LOFI_JAZZ_APP_ID__: JSON.stringify(cloudAppId ?? ""),
      __LOFI_JAZZ_SERVER_URL__: JSON.stringify(cloudServerUrl ?? ""),
    },
    resolve: {
      alias: [
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/recipes\\/file-handler$/, replacement: ${
    JSON.stringify(fileHandlerRecipe)
  } },
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/recipes\\/launch-handler$/, replacement: ${
    JSON.stringify(launchHandlerRecipe)
  } },
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/recipes\\/protocol-handler$/, replacement: ${
    JSON.stringify(protocolHandlerRecipe)
  } },
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/recipes\\/related-app-discovery$/, replacement: ${
    JSON.stringify(relatedAppDiscoveryRecipe)
  } },
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/recipes\\/scope-extension$/, replacement: ${
    JSON.stringify(scopeExtensionRecipe)
  } },
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/recipes\\/web-share$/, replacement: ${
    JSON.stringify(webShareRecipe)
  } },
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/recipes\\/window-controls-overlay$/, replacement: ${
    JSON.stringify(windowControlsOverlayRecipe)
  } },
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/preact$/, replacement: ${JSON.stringify(preactEntry)} },
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/access$/, replacement: ${JSON.stringify(accessEntry)} },
        { find: /^jsr:@nzip\\/lofi@[^/]+$/, replacement: ${JSON.stringify(runtimeEntry)} },
        { find: /^npm:preact@[^/]+\\/hooks$/, replacement: "preact/hooks" },
        { find: /^npm:preact@[^/]+\\/jsx-dev-runtime$/, replacement: "preact/jsx-dev-runtime" },
        { find: /^npm:preact@[^/]+\\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
        { find: /^npm:preact@[^/]+$/, replacement: "preact" },
        { find: /^npm:jazz-tools@[^/]+\\/passkey-backup$/, replacement: "jazz-tools/passkey-backup" },
        { find: /^npm:jazz-tools@[^/]+\\/passphrase$/, replacement: "jazz-tools/passphrase" },
        { find: /^npm:jazz-tools@[^/]+$/, replacement: "jazz-tools" },
        { find: "@nzip/lofi/recipes/launch-handler", replacement: ${
    JSON.stringify(launchHandlerRecipe)
  } },
        { find: "@nzip/lofi/recipes/protocol-handler", replacement: ${
    JSON.stringify(protocolHandlerRecipe)
  } },
        { find: "@nzip/lofi/recipes/related-app-discovery", replacement: ${
    JSON.stringify(relatedAppDiscoveryRecipe)
  } },
        { find: "@nzip/lofi/recipes/scope-extension", replacement: ${
    JSON.stringify(scopeExtensionRecipe)
  } },
        { find: "@nzip/lofi/recipes/file-handler", replacement: ${
    JSON.stringify(fileHandlerRecipe)
  } },
        { find: "@nzip/lofi/recipes/web-share", replacement: ${JSON.stringify(webShareRecipe)} },
        { find: "@nzip/lofi/recipes/window-controls-overlay", replacement: ${
    JSON.stringify(windowControlsOverlayRecipe)
  } },
        { find: "@nzip/lofi/preact", replacement: ${JSON.stringify(preactEntry)} },
        { find: "@nzip/lofi/access", replacement: ${JSON.stringify(accessEntry)} },
        { find: "@nzip/lofi", replacement: ${JSON.stringify(runtimeEntry)} },
      ],
      noExternal: ["@astrojs/preact"],
    },
  },
});
`;
}

/**
 * Materializes the package-owned Astro/Jazz integration into an ignored tooling
 * directory so Astro's Node-compatible config loader can consume it.
 */
export async function prepareLofiAstroConfig(options: LofiAstroOptions = {}): Promise<string> {
  const projectRoot = resolve(options.root ?? Deno.cwd());
  if (options.schemaDir && options.schemaDir !== "src") {
    throw new Error("custom schemaDir is not supported by the generated lofi Astro integration");
  }
  const toolingDir = join(projectRoot, ".lofi");
  const path = join(toolingDir, "astro.config.ts");
  const packageDir = join(toolingDir, "package");
  await Deno.mkdir(join(packageDir, "runtime"), { recursive: true });
  await Deno.mkdir(join(packageDir, "access"), { recursive: true });
  await Deno.mkdir(join(packageDir, "preact"), { recursive: true });
  await Deno.mkdir(join(packageDir, "recipes"), { recursive: true });
  for (const file of runtimeFiles) {
    await Deno.writeTextFile(
      join(packageDir, "runtime", file),
      await readPackageFile(`../runtime/${file}`),
    );
  }
  for (const file of preactFiles) {
    await Deno.writeTextFile(
      join(packageDir, "preact", file),
      await readPackageFile(`../preact/${file}`),
    );
  }
  for (const file of accessFiles) {
    await Deno.writeTextFile(
      join(packageDir, "access", file),
      await readPackageFile(`../access/${file}`),
    );
  }
  for (const file of recipeFiles) {
    await Deno.writeTextFile(
      join(packageDir, "recipes", file),
      await readPackageFile(`../recipes/${file}`),
    );
  }
  const configSource = renderConfig(projectRoot);
  let current = "";
  try {
    current = await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (current !== configSource) await Deno.writeTextFile(path, configSource);
  return path;
}
