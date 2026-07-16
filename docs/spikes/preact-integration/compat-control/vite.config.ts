import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const compat = fileURLToPath(
  new URL(
    "../../../node_modules/.deno/preact@10.29.7/node_modules/preact/compat/dist/compat.module.js",
    import.meta.url,
  ),
);
const jsxRuntime = fileURLToPath(
  new URL(
    "../../../node_modules/.deno/preact@10.29.7/node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js",
    import.meta.url,
  ),
);

export default defineConfig({
  resolve: {
    alias: [
      { find: "react/jsx-runtime", replacement: jsxRuntime },
      { find: "react-dom", replacement: compat },
      { find: "react", replacement: compat },
    ],
  },
});
