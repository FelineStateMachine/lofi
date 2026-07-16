import denoConfig from "../apps/reference/deno.json" with { type: "text" };
import astroConfig from "../apps/reference/astro.config.ts" with { type: "text" };
import favicon from "../apps/reference/public/favicon.svg" with { type: "text" };
import manifest from "../apps/reference/public/manifest.webmanifest" with { type: "text" };
import serviceWorker from "../apps/reference/public/sw.js" with { type: "text" };
import deviceStatus from "../apps/reference/src/_lofi/DeviceStatus.tsx" with { type: "text" };
import shell from "../apps/reference/src/_lofi/Shell.astro" with { type: "text" };
import boot from "../apps/reference/src/_lofi/boot.ts" with { type: "text" };
import config from "../apps/reference/src/_lofi/config.ts" with { type: "text" };
import diagnostics from "../apps/reference/src/_lofi/diagnostics.ts" with { type: "text" };
import tableStore from "../apps/reference/src/_lofi/table-store.ts" with { type: "text" };
import tableStoreTest from "../apps/reference/src/_lofi/table-store_test.ts" with {
  type: "text",
};
import deviceCapabilities from "../apps/reference/src/_lofi/device-capabilities.ts" with {
  type: "text",
};
import deviceCapabilitiesTest from "../apps/reference/src/_lofi/device-capabilities_test.ts" with {
  type: "text",
};
import inspector from "../apps/reference/src/_lofi/inspector.ts" with { type: "text" };
import inspectorTest from "../apps/reference/src/_lofi/inspector_test.ts" with { type: "text" };
import probe from "../apps/reference/src/_lofi/probe.ts" with { type: "text" };
import pwa from "../apps/reference/src/_lofi/pwa.ts" with { type: "text" };
import pwaTest from "../apps/reference/src/_lofi/pwa_test.ts" with { type: "text" };
import resourceLifecycle from "../apps/reference/src/_lofi/resource-lifecycle.ts" with {
  type: "text",
};
import resourceLifecycleTest from "../apps/reference/src/_lofi/resource-lifecycle_test.ts" with {
  type: "text",
};
import runtime from "../apps/reference/src/_lofi/runtime.ts" with { type: "text" };
import testAssert from "../apps/reference/src/_lofi/test-assert.ts" with { type: "text" };
import uiMutation from "../apps/reference/src/_lofi/ui-mutation.ts" with { type: "text" };
import uiMutationTest from "../apps/reference/src/_lofi/ui-mutation_test.ts" with {
  type: "text",
};
import useDeviceCapabilities from "../apps/reference/src/_lofi/use-device-capabilities.ts" with {
  type: "text",
};
import useTasks from "../apps/reference/src/islands/use-tasks.ts" with { type: "text" };
import app from "../apps/reference/src/app.ts" with { type: "text" };
import environmentTypes from "../apps/reference/src/env.d.ts" with { type: "text" };
import taskList from "../apps/reference/src/islands/TaskList.tsx" with { type: "text" };
import indexPage from "../apps/reference/src/pages/index.astro" with { type: "text" };
import permissions from "../apps/reference/src/permissions.ts" with { type: "text" };
import schema from "../apps/reference/src/schema.ts" with { type: "text" };
import globalStyles from "../apps/reference/src/styles/global.css" with { type: "text" };
import authorBoundaryTest from "../apps/reference/tests/author-boundary_test.ts" with {
  type: "text",
};
import testingContractTest from "../apps/reference/tests/testing-contract_test.ts" with {
  type: "text",
};
import convergenceExample from "../apps/reference/tests/convergence_e2e_test.ts" with {
  type: "text",
};
import tsconfig from "../apps/reference/tsconfig.json" with { type: "text" };

/** Every source-controlled file copied from the validated reference app into a new project. */
export const STARTER_TEMPLATE: Readonly<Record<string, string>> = {
  "deno.json": denoConfig,
  "astro.config.ts": astroConfig,
  "public/favicon.svg": favicon,
  "public/manifest.webmanifest": manifest,
  "public/sw.js": serviceWorker,
  "src/_lofi/DeviceStatus.tsx": deviceStatus,
  "src/_lofi/Shell.astro": shell,
  "src/_lofi/boot.ts": boot,
  "src/_lofi/config.ts": config,
  "src/_lofi/diagnostics.ts": diagnostics,
  "src/_lofi/device-capabilities.ts": deviceCapabilities,
  "src/_lofi/device-capabilities_test.ts": deviceCapabilitiesTest,
  "src/_lofi/inspector.ts": inspector,
  "src/_lofi/inspector_test.ts": inspectorTest,
  "src/_lofi/probe.ts": probe,
  "src/_lofi/pwa.ts": pwa,
  "src/_lofi/pwa_test.ts": pwaTest,
  "src/_lofi/resource-lifecycle.ts": resourceLifecycle,
  "src/_lofi/resource-lifecycle_test.ts": resourceLifecycleTest,
  "src/_lofi/runtime.ts": runtime,
  "src/_lofi/table-store.ts": tableStore,
  "src/_lofi/table-store_test.ts": tableStoreTest,
  "src/_lofi/test-assert.ts": testAssert,
  "src/_lofi/ui-mutation.ts": uiMutation,
  "src/_lofi/ui-mutation_test.ts": uiMutationTest,
  "src/_lofi/use-device-capabilities.ts": useDeviceCapabilities,
  "src/app.ts": app,
  "src/env.d.ts": environmentTypes,
  "src/islands/TaskList.tsx": taskList,
  "src/islands/use-tasks.ts": useTasks,
  "src/pages/index.astro": indexPage,
  "src/permissions.ts": permissions,
  "src/schema.ts": schema,
  "src/styles/global.css": globalStyles,
  "tests/author-boundary_test.ts": authorBoundaryTest,
  "tests/convergence_e2e_test.ts": convergenceExample,
  "tests/testing-contract_test.ts": testingContractTest,
  "tsconfig.json": tsconfig,
};
