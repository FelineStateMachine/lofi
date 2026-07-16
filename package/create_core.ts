import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { STARTER_TEMPLATE } from "./starter_template.ts";
import { LOFI_PACKAGE_PREFIX } from "./version.ts";

export type CreateProjectOptions = {
  cwd: string;
  name: string;
  packagePrefix?: string;
};

export type CreateProjectResult = {
  destination: string;
  displayPath: string;
  nextCommands: readonly [string, string];
};

export const CREATE_CORE_FILE_NAMES = {
  environment: ".env.example",
  gitignore: ".gitignore",
  readme: "README.md",
  denoConfig: "deno.json",
} as const;

const generatedGitignore = `.env
.env.*
!.env.example

node_modules/
.astro/
.vite/
dist/
coverage/
playwright-report/
test-results/
.playwright-cli/
.nzip-*/
.DS_Store
`;

const generatedEnvironment =
  `# Optional public Jazz cloud configuration. Leave both blank for local-only mode.
JAZZ_APP_ID=
JAZZ_SERVER_URL=

# Server-only credentials. Never expose these through PUBLIC_ or client code.
JAZZ_ADMIN_SECRET=
BACKEND_SECRET=
`;

function generatedReadme(name: string): string {
  return `# ${name}

This local-first PWA was created with \`@nzip/lofi\`.

\`\`\`sh
deno task dev
\`\`\`

The default project runs local-only with durable browser storage. To enable managed sync, copy
\`.env.example\` to \`.env\` and set both public Jazz values. Run \`deno task doctor\` before boot when
you want configuration diagnostics without starting the application.

Public tasks: \`dev\`, \`doctor\`, \`check\`, \`test\`, \`build\`, and \`preview\`.

For a stable HTTPS origin on a physical device, create or select a Deno Deploy application once, set
only \`JAZZ_APP_ID\` and \`JAZZ_SERVER_URL\` in its Local environment when cloud sync is wanted, then
run:

\`\`\`sh
deno task --tunnel dev
\`\`\`

Deno Tunnel keeps the project hostname stable across restarts and reflects local edits live. Use a
production build published through nzip for install, service-worker, and offline cold-start
evidence.

Generated file ownership is documented in the
[lofi generated project map](https://github.com/FelineStateMachine/lofi/blob/main/docs/generated-project-map.md).
`;
}

function generatedDenoConfig(packagePrefix: string): string {
  const packageCommand = (subpath: string, localPath: string) =>
    packagePrefix.startsWith("file:")
      ? `${packagePrefix}${localPath}`
      : `${packagePrefix}${subpath}`;
  const config = {
    imports: {
      "@astrojs/check": "npm:@astrojs/check@0.9.9",
      "@astrojs/preact": "npm:@astrojs/preact@6.0.1",
      "@nzip/lofi/": packagePrefix,
      "@nzip/lofi/build": packageCommand("build", "commands/build.ts"),
      "@nzip/lofi/check": packageCommand("check", "commands/check.ts"),
      "@nzip/lofi/dev": packageCommand("dev", "commands/dev.ts"),
      "@nzip/lofi/doctor": packageCommand("doctor", "commands/doctor.ts"),
      "@nzip/lofi/preview": packageCommand("preview", "commands/preview.ts"),
      "@nzip/lofi/testing": packageCommand("testing", "testing/mod.ts"),
      "@nzip/lofi/test": packageCommand("test", "commands/run_tests.ts"),
      "astro": "npm:astro@7.0.9",
      "astro/config": "npm:astro@7.0.9/config",
      "jazz-tools": "npm:jazz-tools@2.0.0-alpha.53",
      "jazz-tools/dev/vite": "npm:jazz-tools@2.0.0-alpha.53/dev/vite",
      "preact": "npm:preact@10.29.7",
      "preact/hooks": "npm:preact@10.29.7/hooks",
      "preact/jsx-dev-runtime": "npm:preact@10.29.7/jsx-dev-runtime",
      "preact/jsx-runtime": "npm:preact@10.29.7/jsx-runtime",
      "typescript": "npm:typescript@6.0.3",
      "vite": "npm:vite@8.0.1",
    },
    nodeModulesDir: "auto",
    compilerOptions: {
      lib: ["deno.ns", "dom", "dom.iterable", "esnext"],
      jsx: "react-jsx",
      jsxImportSource: "preact",
    },
    tasks: {
      dev: "deno run -A @nzip/lofi/dev",
      doctor: "deno run -A @nzip/lofi/doctor",
      check: "deno run -A @nzip/lofi/check",
      test: "deno run -A @nzip/lofi/test",
      build: "deno run -A @nzip/lofi/build",
      preview: "deno run -A @nzip/lofi/preview",
    },
    fmt: {
      lineWidth: 100,
      semiColons: true,
      singleQuote: false,
    },
    lint: {
      rules: { tags: ["recommended"] },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function validateName(name: string): string[] {
  if (name.trim() !== name || name.length === 0) {
    throw new Error("project name must be a non-empty relative path without surrounding spaces");
  }
  if (isAbsolute(name)) throw new Error("project name must be a relative path");
  const segments = name.split(/[\\/]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("project name cannot contain empty, '.' or '..' path segments");
  }
  for (const segment of segments) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(segment)) {
      throw new Error(
        `project path segment ${
          JSON.stringify(segment)
        } must start with a letter or number and contain only letters, numbers, '.', '_' or '-'`,
      );
    }
  }
  return segments;
}

async function directoryIsEmpty(path: string): Promise<boolean> {
  try {
    for await (const _entry of Deno.readDir(path)) return false;
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    if (error instanceof Deno.errors.NotADirectory) return false;
    throw error;
  }
}

async function assertNoSymlinkPath(cwd: string, segments: readonly string[]): Promise<void> {
  let path = cwd;
  for (const segment of segments) {
    path = join(path, segment);
    try {
      const stat = await Deno.lstat(path);
      if (stat.isSymlink) {
        throw new Error(
          `destination path crosses symbolic link ${
            JSON.stringify(relative(cwd, path))
          }; no files were changed. Choose a path without symbolic links`,
        );
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  }
}

async function writeTemplate(destination: string): Promise<void> {
  for (const [relativePath, content] of Object.entries(STARTER_TEMPLATE)) {
    const path = join(destination, relativePath);
    await Deno.mkdir(dirname(path), { recursive: true });
    if (typeof content === "string") await Deno.writeTextFile(path, content);
    else await Deno.writeFile(path, content);
  }
}

async function rewritePortableAstroConfig(root: string): Promise<void> {
  const path = join(root, "astro.config.ts");
  const source = await Deno.readTextFile(path);
  const portable = source.replace(
    'const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));',
    'const workspaceRoot = fileURLToPath(new URL("./", import.meta.url));',
  );
  if (portable === source) throw new Error("starter Astro workspace-root marker was not found");
  await Deno.writeTextFile(path, portable);
}

export async function createProject(options: CreateProjectOptions): Promise<CreateProjectResult> {
  const segments = validateName(options.name);
  const cwd = resolve(options.cwd);
  const destination = resolve(cwd, ...segments);
  const child = relative(cwd, destination);
  if (child.startsWith(`..${sep}`) || child === "..") {
    throw new Error("project destination must stay inside the current directory");
  }
  await assertNoSymlinkPath(cwd, segments);

  if (!(await directoryIsEmpty(destination))) {
    throw new Error(
      `destination ${
        JSON.stringify(options.name)
      } already exists and is not empty; no files were changed. Choose a new name, for example: deno run -A jsr:@nzip/lofi/create ${
        basename(options.name)
      }-new`,
    );
  }

  await Deno.mkdir(dirname(destination), { recursive: true });
  const staging = await Deno.makeTempDir({
    dir: dirname(destination),
    prefix: `.${basename(destination)}-lofi-create-`,
  });
  try {
    await writeTemplate(staging);
    await rewritePortableAstroConfig(staging);
    await Deno.writeTextFile(
      join(staging, CREATE_CORE_FILE_NAMES.gitignore),
      generatedGitignore,
    );
    await Deno.writeTextFile(
      join(staging, CREATE_CORE_FILE_NAMES.environment),
      generatedEnvironment,
    );
    await Deno.writeTextFile(
      join(staging, CREATE_CORE_FILE_NAMES.readme),
      generatedReadme(basename(destination)),
    );
    await Deno.writeTextFile(
      join(staging, CREATE_CORE_FILE_NAMES.denoConfig),
      generatedDenoConfig(options.packagePrefix ?? LOFI_PACKAGE_PREFIX),
    );

    await Deno.remove(destination).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    await Deno.rename(staging, destination);
  } catch (error) {
    await Deno.remove(staging, { recursive: true }).catch(() => undefined);
    throw error;
  }

  return {
    destination,
    displayPath: options.name,
    nextCommands: [`cd ${options.name}`, "deno task dev"],
  };
}
