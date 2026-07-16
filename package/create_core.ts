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

Public tasks: \`dev\`, \`doctor\`, \`test\`, \`build\`, and \`preview\`. Schema and sync tasks:
\`schema:validate\`, \`schema:deploy\`, \`migrations:create\`, and \`migrations:push\`.
`;
}

// The `@nzip/lofi/*` import keys the template carries as local repo paths; a
// generated project resolves the same keys through the published package (or a
// file: override in clean-room tests). Everything else in the template deno.json
// — npm imports, tasks (including schema/migration/deploy), fmt, lint — is copied
// verbatim, so the template is the single source of truth for project config.
const lofiImportTargets: Record<string, { subpath: string; localPath: string }> = {
  "@nzip/lofi/build": { subpath: "build", localPath: "commands/build.ts" },
  "@nzip/lofi/dev": { subpath: "dev", localPath: "commands/dev.ts" },
  "@nzip/lofi/doctor": { subpath: "doctor", localPath: "commands/doctor.ts" },
  "@nzip/lofi/preview": { subpath: "preview", localPath: "commands/preview.ts" },
  "@nzip/lofi/test": { subpath: "test", localPath: "commands/run_tests.ts" },
  "@nzip/lofi/testing": { subpath: "testing", localPath: "testing/mod.ts" },
};

async function rewritePortableDenoConfig(root: string, packagePrefix: string): Promise<void> {
  const path = join(root, "deno.json");
  const config = JSON.parse(await Deno.readTextFile(path));
  const imports = config.imports as Record<string, string> | undefined;
  if (!imports || typeof imports["@nzip/lofi/"] !== "string") {
    throw new Error("starter deno.json is missing the @nzip/lofi/ import marker");
  }
  const isFileOverride = packagePrefix.startsWith("file:");
  imports["@nzip/lofi/"] = packagePrefix;
  for (const [key, { subpath, localPath }] of Object.entries(lofiImportTargets)) {
    if (typeof imports[key] !== "string") {
      throw new Error(`starter deno.json is missing the ${key} import`);
    }
    imports[key] = isFileOverride ? `${packagePrefix}${localPath}` : `${packagePrefix}${subpath}`;
  }
  await Deno.writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`);
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
    await Deno.writeTextFile(path, content);
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
    await rewritePortableDenoConfig(staging, options.packagePrefix ?? LOFI_PACKAGE_PREFIX);
    await Deno.writeTextFile(join(staging, ".gitignore"), generatedGitignore);
    await Deno.writeTextFile(join(staging, ".env.example"), generatedEnvironment);
    await Deno.writeTextFile(join(staging, "README.md"), generatedReadme(basename(destination)));

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
