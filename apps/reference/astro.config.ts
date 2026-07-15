import { fileURLToPath } from "node:url";
import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";
import { jazzPlugin } from "jazz-tools/dev/vite";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const schemaDir = fileURLToPath(new URL("./src", import.meta.url));
const cloudAppId = process.env.JAZZ_APP_ID?.trim();
const cloudServerUrl = process.env.JAZZ_SERVER_URL?.trim();
const managedJazzServer = process.env.LOFI_SKIP_JAZZ_MANAGED === "1"
  ? false
  : { allowLocalFirstAuth: true };

if (Boolean(cloudAppId) !== Boolean(cloudServerUrl)) {
  throw new Error(
    "Cloud mode requires both JAZZ_APP_ID and JAZZ_SERVER_URL; set the missing name or remove the partial pair.",
  );
}
export default defineConfig({
  output: "static",
  integrations: [preact({ compat: true, devtools: true })],
  vite: {
    plugins: [
      jazzPlugin({
        schemaDir,
        inspector: false,
        server: managedJazzServer,
      }),
    ],
    server: {
      fs: { allow: [workspaceRoot] },
    },
    define: {
      __LOFI_JAZZ_APP_ID__: JSON.stringify(cloudAppId ?? ""),
      __LOFI_JAZZ_SERVER_URL__: JSON.stringify(cloudServerUrl ?? ""),
    },
    resolve: {
      noExternal: ["@astrojs/preact"],
    },
  },
});
