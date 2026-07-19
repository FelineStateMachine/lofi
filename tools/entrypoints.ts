/**
 * The JSR entrypoint catalog shared by documentation tooling. `tools/doc_lint.ts`
 * lints every file listed here and `tools/api_docs.ts` renders one API page per
 * `page`, so adding an export to deno.json requires updating this list (the
 * lint task fails on undocumented modules either way).
 */
export type Entrypoint = {
  /** JSR export specifier, e.g. `.` or `./recipes/web-share`. */
  jsrName: string;
  /** Repo-relative module file. */
  file: string;
  /** API page id under `website/api-gen/`; shared pages group several exports. */
  page: string;
  /** Human heading for the export's section or page. */
  title: string;
};

export const entrypoints: readonly Entrypoint[] = [
  { jsrName: ".", file: "package/runtime/mod.ts", page: "runtime", title: "Runtime" },
  { jsrName: "./schema", file: "package/schema/mod.ts", page: "schema", title: "Schema" },
  {
    jsrName: "./schema/store",
    file: "package/schema/store.ts",
    page: "schema-store",
    title: "Store provisioning",
  },
  { jsrName: "./astro", file: "package/astro/mod.ts", page: "astro", title: "Astro integration" },
  { jsrName: "./access", file: "package/access/mod.ts", page: "access", title: "Access" },
  { jsrName: "./preact", file: "package/preact/mod.ts", page: "preact", title: "Preact" },
  { jsrName: "./testing", file: "package/testing/mod.ts", page: "testing", title: "Testing" },
  { jsrName: "./create", file: "package/create.ts", page: "cli", title: "create" },
  { jsrName: "./build", file: "package/commands/build.ts", page: "cli", title: "build" },
  { jsrName: "./dev", file: "package/commands/dev.ts", page: "cli", title: "dev" },
  { jsrName: "./doctor", file: "package/commands/doctor.ts", page: "cli", title: "doctor" },
  { jsrName: "./preview", file: "package/commands/preview.ts", page: "cli", title: "preview" },
  {
    jsrName: "./provision",
    file: "package/commands/provision.ts",
    page: "cli",
    title: "provision",
  },
  { jsrName: "./test", file: "package/commands/run_tests.ts", page: "cli", title: "test" },
  {
    jsrName: "./recipes/file-handler",
    file: "package/recipes/file-handler.ts",
    page: "recipes/file-handler",
    title: "File handler",
  },
  {
    jsrName: "./recipes/launch-handler",
    file: "package/recipes/launch-handler.ts",
    page: "recipes/launch-handler",
    title: "Launch handler",
  },
  {
    jsrName: "./recipes/protocol-handler",
    file: "package/recipes/protocol-handler.ts",
    page: "recipes/protocol-handler",
    title: "Protocol handler",
  },
  {
    jsrName: "./recipes/related-app-discovery",
    file: "package/recipes/related-app-discovery.ts",
    page: "recipes/related-app-discovery",
    title: "Related-app discovery",
  },
  {
    jsrName: "./recipes/scope-extension",
    file: "package/recipes/scope-extension.ts",
    page: "recipes/scope-extension",
    title: "Scope extension",
  },
  {
    jsrName: "./recipes/web-share",
    file: "package/recipes/web-share.ts",
    page: "recipes/web-share",
    title: "Web Share",
  },
  {
    jsrName: "./recipes/window-controls-overlay",
    file: "package/recipes/window-controls-overlay.ts",
    page: "recipes/window-controls-overlay",
    title: "Window controls overlay",
  },
] as const;
