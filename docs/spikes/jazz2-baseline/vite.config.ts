import { fileURLToPath } from "node:url";
import { jazzPlugin } from "jazz-tools/dev/vite";
import { defineConfig } from "vite";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const cloudAppId = process.env.JAZZ_APP_ID?.trim();
const cloudServerUrl = process.env.JAZZ_SERVER_URL?.trim();

if (Boolean(cloudAppId) !== Boolean(cloudServerUrl)) {
  throw new Error(
    "Cloud mode requires both JAZZ_APP_ID and JAZZ_SERVER_URL; set the missing name or remove the partial pair.",
  );
}

// Only the public pair is projected into Vite's client namespace. Jazz's
// server credentials remain unprefixed for schema publication by the plugin.
if (cloudAppId && cloudServerUrl) {
  process.env.VITE_JAZZ_APP_ID = cloudAppId;
  process.env.VITE_JAZZ_SERVER_URL = cloudServerUrl;
}

export default defineConfig({
  plugins: [
    jazzPlugin({
      schemaDir: import.meta.dirname,
      inspector: false,
      server: {
        allowLocalFirstAuth: true,
      },
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // Deno places npm packages under the workspace's hidden node_modules/.deno
    // tree. Jazz resolves its WASM to that absolute path, so Vite must allow
    // the workspace root rather than only this nested spike root.
    fs: {
      allow: [workspaceRoot],
    },
  },
});
