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

// Jazz's managed Vite plugin reads the VITE_ pair when selecting the server
// that receives schema, migration, and permission publication. The reference
// runtime still receives explicit build constants below, so only this public
// pair enters Vite's client-visible namespace and server secrets remain private.
if (cloudAppId && cloudServerUrl) {
  process.env.VITE_JAZZ_APP_ID = cloudAppId;
  process.env.VITE_JAZZ_SERVER_URL = cloudServerUrl;
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
      // Running a public development tunnel is an explicit author decision. Do not add a
      // second framework hostname policy on top of the dev server they chose to expose.
      allowedHosts: true,
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
