/**
 * Astro and Vite integration used by generated lofi applications.
 *
 * {@link prepareLofiAstroConfig} materializes version-matched runtime aliases
 * and Jazz configuration into the ignored `.lofi/` directory.
 *
 * The generated configuration reads these environment variables at Astro
 * config-load time:
 *
 * - `LOFI_BASE_PATH` — deployment base path for the built site (default `/`).
 * - `LOFI_CSP` — set to `off` to disable the Content-Security-Policy meta tags
 *   Astro emits per page (on by default).
 * - `LOFI_CSP_SCRIPT_SRC` — space-separated sources appended to the
 *   `script-src` directive.
 * - `LOFI_CSP_STYLE_SRC` — space-separated sources appended to the
 *   `style-src` directive.
 * - `LOFI_CSP_CONNECT_SRC` — sources for a `connect-src` directive; absent by
 *   default because the sync location is user data enrolled at runtime.
 * - `LOFI_CSP_DIRECTIVES` — semicolon-separated additional CSP directives.
 * - `JAZZ_APP_ID` — cloud-mode Jazz application id; requires
 *   `JAZZ_SERVER_URL`.
 * - `JAZZ_SERVER_URL` — cloud-mode Jazz sync server URL; requires
 *   `JAZZ_APP_ID`.
 * - `LOFI_SKIP_JAZZ_MANAGED` — set to `1` to skip starting the managed local
 *   Jazz server during development.
 *
 * @module
 */

import { join, resolve } from "node:path";
import { accessFiles, preactFiles, recipeFiles, runtimeFiles, schemaFiles } from "./manifest.ts";

/** Options for materializing the package-owned Astro configuration. */
export type LofiAstroOptions = {
  /** Project root. Defaults to the directory from which Astro was invoked. */
  root?: string;
  /**
   * The directory the generated integration reads the Jazz schema and
   * permissions from. `src` is the contract: the type admits nothing else,
   * and the runtime check rejects any other value.
   * @default "src"
   */
  schemaDir?: "src";
};

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
  const schemaEntry = join(projectRoot, ".lofi", "package", "schema", "mod.ts");
  const schemaStoreEntry = join(projectRoot, ".lofi", "package", "schema", "store.ts");
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
// The vendored runtime's crypto dependencies are imported only by files Vite
// serves, so nothing on the Deno side would otherwise materialize them into
// node_modules where Vite resolves bare specifiers. Loading them here pins
// them into the project's node_modules at config time.
import "@noble/ciphers/chacha";
import "@noble/curves/ed25519";
import "@noble/hashes/hkdf";
import "@noble/hashes/sha2";

const projectRoot = Deno.cwd();
const schemaDir = resolve(projectRoot, "src");
const cloudAppId = process.env.JAZZ_APP_ID?.trim();
const cloudServerUrl = process.env.JAZZ_SERVER_URL?.trim();
const managedJazzServer = process.env.LOFI_SKIP_JAZZ_MANAGED === "1"
  ? false
  : { allowLocalFirstAuth: true };
const deploymentBase = process.env.LOFI_BASE_PATH || "/";
// Content-Security-Policy: on by default; Astro emits a per-page meta tag
// with hashes for its inline island scripts. 'wasm-unsafe-eval' admits the
// Jazz engine's WebAssembly.instantiate; connect-src is absent by default
// because the sync location is user data enrolled at runtime, not build
// configuration. LOFI_CSP=off disables (reported by the build, not blocked).
const cspOff = (process.env.LOFI_CSP || "").trim() === "off";
const cspList = (name) => (process.env[name] || "").split(" ").filter(Boolean);
const cspExtraDirectives = (process.env.LOFI_CSP_DIRECTIVES || "")
  .split(";").map((entry) => entry.trim()).filter(Boolean);
const cspConnect = (process.env.LOFI_CSP_CONNECT_SRC || "").trim();
const cspSecurity = cspOff ? {} : {
  csp: {
    scriptDirective: {
      resources: ["'self'", "'wasm-unsafe-eval'", ...cspList("LOFI_CSP_SCRIPT_SRC")],
    },
    styleDirective: { resources: ["'self'", ...cspList("LOFI_CSP_STYLE_SRC")] },
    directives: [
      "object-src 'none'",
      "base-uri 'self'",
      "worker-src 'self'",
      ...(cspConnect ? ["connect-src " + cspConnect] : []),
      ...cspExtraDirectives,
    ],
  },
};

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
  security: cspSecurity,
  trailingSlash: "always",
  integrations: [preact({ compat: true, devtools: true })],
  vite: {
    plugins: [jazzPlugin({ schemaDir, inspector: false, server: managedJazzServer })],
    server: { fs: { allow: [projectRoot] } },
    // The worker sub-build falls back to Vite's default asset template
    // ("[name]-[hash][extname]") while Astro names client assets
    // "[name].[hash][extname]", so the Jazz WASM binary — imported by both the
    // runtime and the jazz worker — lands in dist twice under two names.
    // Matching Astro's template collapses the copies into one file.
    worker: {
      rollupOptions: {
        output: { assetFileNames: "_astro/[name].[hash][extname]" },
      },
    },
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
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/schema\\/store$/, replacement: ${
    JSON.stringify(schemaStoreEntry)
  } },
        { find: /^jsr:@nzip\\/lofi@[^/]+\\/schema$/, replacement: ${JSON.stringify(schemaEntry)} },
        { find: /^jsr:@nzip\\/lofi@[^/]+$/, replacement: ${JSON.stringify(runtimeEntry)} },
        { find: /^npm:preact@[^/]+\\/hooks$/, replacement: "preact/hooks" },
        { find: /^npm:preact@[^/]+\\/jsx-dev-runtime$/, replacement: "preact/jsx-dev-runtime" },
        { find: /^npm:preact@[^/]+\\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
        { find: /^npm:preact@[^/]+$/, replacement: "preact" },
        { find: /^npm:@noble\\/ciphers@[^/]+\\/chacha$/, replacement: "@noble/ciphers/chacha" },
        { find: /^npm:@noble\\/hashes@[^/]+\\/hkdf$/, replacement: "@noble/hashes/hkdf" },
        { find: /^npm:@noble\\/hashes@[^/]+\\/sha2$/, replacement: "@noble/hashes/sha2" },
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
        { find: "@nzip/lofi/schema", replacement: ${JSON.stringify(schemaEntry)} },
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
 *
 * Vendors the runtime, access, preact, recipe, and schema modules into
 * `.lofi/package/` and writes `.lofi/astro.config.ts`, rewriting the config
 * only when its content changes.
 *
 * @param options The project root and schema directory; both optional.
 * @returns The absolute path of the generated `.lofi/astro.config.ts`.
 */
export async function prepareLofiAstroConfig(options: LofiAstroOptions = {}): Promise<string> {
  const projectRoot = resolve(options.root ?? Deno.cwd());
  // Type-level contract; kept at runtime against unchecked JavaScript callers.
  if (options.schemaDir !== undefined && options.schemaDir !== "src") {
    throw new Error("custom schemaDir is not supported by the generated lofi Astro integration");
  }
  const toolingDir = join(projectRoot, ".lofi");
  const path = join(toolingDir, "astro.config.ts");
  const packageDir = join(toolingDir, "package");
  await Deno.mkdir(join(packageDir, "runtime"), { recursive: true });
  await Deno.mkdir(join(packageDir, "access"), { recursive: true });
  await Deno.mkdir(join(packageDir, "preact"), { recursive: true });
  await Deno.mkdir(join(packageDir, "recipes"), { recursive: true });
  await Deno.mkdir(join(packageDir, "schema"), { recursive: true });
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
  for (const file of schemaFiles) {
    await Deno.writeTextFile(
      join(packageDir, "schema", file),
      await readPackageFile(`../schema/${file}`),
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
