import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readStarterFile, STARTER_FILES } from "./starter_template.ts";
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
.lofi/
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
# Run \`deno task jazz:provision\` to generate a managed Jazz app and fill these in.
JAZZ_APP_ID=
JAZZ_SERVER_URL=

# Server-only credentials. Never expose these through PUBLIC_ or client code.
JAZZ_ADMIN_SECRET=
BACKEND_SECRET=
`;

function generatedReadme(name: string): string {
  return `# ${name}

This local-first PWA was created with \`@nzip/lofi\`.

[Framework documentation](https://github.com/FelineStateMachine/lofi/tree/main/docs)

\`\`\`sh
deno task dev
\`\`\`

The default project runs local-only with durable browser storage — it opens instantly on a private,
on-device account with no sign-in. To enable managed sync and account backup, run
\`deno task jazz:provision\` (it generates a managed Jazz app and writes \`.env\`), then rebuild. Run
\`deno task doctor\` before boot when you want configuration diagnostics without starting the app.

## Accounts: back up & recover

With a Jazz app configured, the \`AccountGate\` island lets a user back up and sync their local account,
restore it with a recoverable passkey, or use the portable 24-word recovery phrase fallback. The
account they already have carries over — electing to sync never changes its identity. Passkey restore
is scoped to the app's stable relying-party ID; provider syncing is not universally portable. The
framework implementation is provided by \`@nzip/lofi\`.

## Sharing and groups

The optional \`@nzip/lofi/access\` entrypoint provides private, direct-share, and fixed-role group
templates over ordinary Jazz schemas. Collaboration requires configured sync and fails explicitly in
local-only mode. Start with the
[permissions guide](https://github.com/FelineStateMachine/lofi/blob/main/docs/permissions.md) and the
[access API reference](https://github.com/FelineStateMachine/lofi/blob/main/docs/reference/access.md).

Public tasks: \`dev\`, \`doctor\`, \`test\`, \`build\`, and \`preview\`. Sync/backup and schema tasks:
\`jazz:provision\`, \`schema:validate\`, \`schema:deploy\`, \`migrations:create\`, and \`migrations:push\`.

Start with the framework's
[generated-app guide](https://github.com/FelineStateMachine/lofi/blob/main/docs/getting-started.md)
when replacing the task example with your own schema, permissions, hook, and UI.
The [exact generated-project map](https://github.com/FelineStateMachine/lofi/blob/main/docs/reference/project-layout.md)
lists every source-controlled path and its ownership.

Runtime, PWA, identity, sync, diagnostics, and Astro/Vite integration come from the one pinned
\`@nzip/lofi\` package version. They are not copied into this project's source.

## Hosting

\`deno task build\` emits a static PWA in \`dist/\`. The deploy tasks host it on Deno Deploy as a
static site — they push the built \`dist/\` as the deploy root, which serves it as plain assets:

- \`deno task deploy:create --org <org> --app <app>\` — one-time: create the app from \`dist/\`.
- \`deno task deploy\` — thereafter: build and push \`dist/\`.

Point them at any other static host by editing those two tasks.
`;
}

// The `@nzip/lofi/*` import keys the template carries as explicit local repo
// paths; a generated project resolves the same keys through the published
// package (or a file: override in clean-room tests). Everything else in the template deno.json
// — npm imports, tasks (including schema/migration/deploy), fmt, lint — is copied
// verbatim, so the template is the single source of truth for project config.
const lofiImportTargets: Record<string, { subpath: string; localPath: string }> = {
  "@nzip/lofi": { subpath: "", localPath: "runtime/mod.ts" },
  "@nzip/lofi/access": { subpath: "access", localPath: "access/mod.ts" },
  "@nzip/lofi/astro": { subpath: "astro", localPath: "astro/mod.ts" },
  "@nzip/lofi/build": { subpath: "build", localPath: "commands/build.ts" },
  "@nzip/lofi/dev": { subpath: "dev", localPath: "commands/dev.ts" },
  "@nzip/lofi/doctor": { subpath: "doctor", localPath: "commands/doctor.ts" },
  "@nzip/lofi/preview": { subpath: "preview", localPath: "commands/preview.ts" },
  "@nzip/lofi/preact": { subpath: "preact", localPath: "preact/mod.ts" },
  "@nzip/lofi/provision": { subpath: "provision", localPath: "commands/provision.ts" },
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
    imports[key] = isFileOverride
      ? `${packagePrefix}${localPath}`
      : subpath
      ? `${packagePrefix}${subpath}`
      : packagePrefix.slice(0, -1);
  }
  // Never copy a Deno `links` override into a generated project. The reference
  // app uses explicit relative imports for its local package development loop.
  delete config.links;
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
  for (const relativePath of STARTER_FILES) {
    const content = await readStarterFile(relativePath);
    const path = join(destination, relativePath);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeFile(path, content);
  }
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
