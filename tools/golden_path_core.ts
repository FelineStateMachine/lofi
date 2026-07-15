import { basename, dirname, join, relative, resolve } from "node:path";

export type JourneySource = "checkout" | "create";

export type CommandRecord = {
  name: string;
  args: string[];
  durationMs: number;
  exitCode: number;
  stdoutPath: string;
  stderrPath: string;
};

export type JourneyAssertion = {
  name: string;
  status: "passed" | "failed" | "blocked";
  detail: string;
};

export type AuthorBoundaryViolation = {
  rule: string;
  path: string;
  line: number;
  excerpt: string;
};

export type JourneyReport = {
  schemaVersion: 1;
  source: JourneySource;
  environmentMode: "isolated-local" | "cloud-allowlisted";
  status: "passed" | "failed";
  startedAt: string;
  completedAt: string;
  runtime: {
    deno: string;
    typescript: string;
    v8: string;
    os: string;
    arch: string;
    browser: string;
  };
  cacheMode: "existing" | "cold";
  measurements: {
    developerCommandCount: number;
    devReadyMs?: number;
    firstRetainedWriteMs?: number;
  };
  commands: CommandRecord[];
  assertions: JourneyAssertion[];
  authorBoundaryViolations: AuthorBoundaryViolation[];
  artifacts: {
    root: string;
    report: string;
    trace: string;
    screenshot: string;
  };
};

export type BoundaryRule = {
  id: string;
  pattern: RegExp;
  allow?: (path: string) => boolean;
};

export const defaultBoundaryRules: readonly BoundaryRule[] = [
  {
    id: "raw-jazz-runtime-import",
    pattern: /(?:from\s+|import\s*\()["']jazz-tools(?:\/[^"']*)?["']/,
    // The M1 contract still explicitly permits the pinned Jazz schema DSL in schema.ts.
    allow: (path) => basename(path) === "schema.ts" || basename(path) === "permissions.ts",
  },
  {
    id: "raw-jazz-client-api",
    pattern: /\b(?:BrowserAuthSecretStore|createDb|JazzProvider|useJazzContext)\b/,
  },
  {
    id: "worker-plumbing",
    pattern: /\b(?:SharedWorker|navigator\.serviceWorker|new\s+Worker)\b/,
  },
  {
    id: "transport-plumbing",
    pattern: /\b(?:JAZZ_SERVER_URL|VITE_JAZZ_[A-Z0-9_]*|transportUrl)\b/,
  },
  { id: "workbox-plumbing", pattern: /\bworkbox\b/i },
  {
    id: "browser-capability-branch",
    pattern: /\b(?:navigator\.storage|navigator\.locks|isSecureContext)\b/,
  },
];

const ignoredDirectoryNames = new Set([
  ".astro",
  ".git",
  ".playwright-cli",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "playwright-report",
  "test-results",
]);

const childEnvironmentAllowlist = [
  "CI",
  "DENO_DIR",
  "GITHUB_ACTIONS",
  "LANG",
  "LC_ALL",
  "NIX_SSL_CERT_FILE",
  "NO_PROXY",
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

function assertWithin(root: string, path: string) {
  const child = relative(resolve(root), resolve(path));
  if (child === "" || (!child.startsWith("..") && !child.startsWith("/"))) return;
  throw new Error(`path escapes project root: ${path}`);
}

function shouldExclude(name: string, isDirectory: boolean, relativePath: string): boolean {
  if (isDirectory && (ignoredDirectoryNames.has(name) || name.startsWith(".nzip-"))) return true;
  // The M2 reference application supersedes this ignored M1 working artifact. A working-tree copy
  // must not accidentally resurrect it just because another agent is moving tracked paths.
  if (isDirectory && relativePath === join("apps", "prototype")) return true;
  if (name === ".env.example") return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  return name.endsWith(".sqlite") || name.includes(".sqlite-");
}

async function copyDirectory(
  sourceRoot: string,
  source: string,
  destination: string,
): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(source)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const displayPath = relative(sourceRoot, from);
    if (shouldExclude(entry.name, entry.isDirectory, displayPath)) continue;
    if (entry.isDirectory) {
      await copyDirectory(sourceRoot, from, to);
    } else if (entry.isFile) {
      await Deno.copyFile(from, to);
    } else if (entry.isSymlink) {
      throw new Error(`clean checkout refuses symlink: ${relative(source, from)}`);
    }
  }
}

export async function materializeCleanProject(
  sourceRoot: string,
  destinationRoot?: string,
): Promise<string> {
  const source = resolve(sourceRoot);
  const destination = destinationRoot
    ? resolve(destinationRoot)
    : join(await Deno.makeTempDir({ prefix: "lofi-golden-" }), "project");
  if (source === destination) throw new Error("clean project destination must differ from source");
  await copyDirectory(source, source, destination);
  return destination;
}

export function safeChildEnvironment(
  source: Record<string, string> = Deno.env.toObject(),
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of childEnvironmentAllowlist) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  environment.CI = "1";
  environment.NO_COLOR = "1";
  // Explicit empties prevent a parent shell's sync credentials from influencing local mode.
  environment.JAZZ_APP_ID = "";
  environment.JAZZ_SERVER_URL = "";
  environment.JAZZ_ADMIN_SECRET = "";
  environment.BACKEND_SECRET = "";
  return environment;
}

export async function installNodeSentinel(
  environment: Record<string, string>,
  artifactRoot: string,
): Promise<Record<string, string>> {
  if (Deno.build.os === "windows") return { ...environment };
  const directory = join(artifactRoot, "node-sentinel");
  const executable = join(directory, "node");
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    executable,
    '#!/bin/sh\necho "error: hidden Node invocation is forbidden by the lofi golden path" >&2\nexit 97\n',
  );
  await Deno.chmod(executable, 0o755);
  return {
    ...environment,
    PATH: environment.PATH ? `${directory}:${environment.PATH}` : directory,
  };
}

async function sourceFiles(path: string): Promise<string[]> {
  const stat = await Deno.stat(path);
  if (stat.isFile) return [path];
  const files: string[] = [];
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(path)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory) files.push(...await sourceFiles(child));
    else if (entry.isFile && /\.(?:astro|css|js|jsx|ts|tsx)$/.test(entry.name)) files.push(child);
  }
  return files;
}

export async function scanAuthorBoundary(
  projectRoot: string,
  authorPaths: readonly string[],
  rules: readonly BoundaryRule[] = defaultBoundaryRules,
): Promise<AuthorBoundaryViolation[]> {
  const root = resolve(projectRoot);
  const files: string[] = [];
  for (const authorPath of authorPaths) {
    const path = resolve(root, authorPath);
    assertWithin(root, path);
    try {
      files.push(...await sourceFiles(path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  const violations: AuthorBoundaryViolation[] = [];
  for (const file of [...new Set(files)].sort()) {
    const displayPath = relative(root, file);
    const lines = (await Deno.readTextFile(file)).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      for (const rule of rules) {
        rule.pattern.lastIndex = 0;
        if (rule.allow?.(displayPath) || !rule.pattern.test(lines[index])) continue;
        violations.push({
          rule: rule.id,
          path: displayPath,
          line: index + 1,
          excerpt: lines[index].trim().slice(0, 160),
        });
      }
    }
  }
  return violations;
}

export async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${description} did not become ready within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

export type CapturedProcess = {
  child: Deno.ChildProcess;
  ready: Promise<string>;
  completed: Promise<Deno.CommandStatus>;
  stdoutPath: string;
  stderrPath: string;
  stop(): Promise<void>;
};

function isAlreadyTerminated(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound ||
    (error instanceof TypeError && error.message.includes("already terminated"));
}

async function captureLines(
  stream: ReadableStream<Uint8Array>,
  path: string,
  onLine: (line: string) => void,
  redactValues: readonly string[] = [],
): Promise<void> {
  const file = await Deno.open(path, { create: true, truncate: true, write: true });
  const writer = file.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const redacted = redactText(line, redactValues);
        await writer.write(encoder.encode(`${redacted}\n`));
        onLine(redacted);
      }
    }
    pending += decoder.decode();
    if (pending) {
      const redacted = redactText(pending, redactValues);
      await writer.write(encoder.encode(redacted));
      onLine(redacted);
    }
  } finally {
    await writer.close();
  }
}

export function redactText(text: string, values: readonly string[]): string {
  let redacted = text;
  const candidates = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const value of candidates) redacted = redacted.split(value).join("[redacted]");
  return redacted;
}

export function startReadyProcess(options: {
  executable?: string;
  cwd: string;
  args: string[];
  environment: Record<string, string>;
  artifactRoot: string;
  name: string;
  readyPattern: RegExp;
  timeoutMs: number;
  redactValues?: readonly string[];
}): CapturedProcess {
  const stdoutPath = join(options.artifactRoot, `${options.name}.stdout.log`);
  const stderrPath = join(options.artifactRoot, `${options.name}.stderr.log`);
  const child = new Deno.Command(options.executable ?? Deno.execPath(), {
    args: options.args,
    cwd: options.cwd,
    clearEnv: true,
    env: options.environment,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let resolveReady!: (value: string) => void;
  let rejectReady!: (error: Error) => void;
  let settled = false;
  const readiness = new Promise<string>((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise;
    rejectReady = rejectReadyPromise;
  });
  const inspectLine = (line: string) => {
    options.readyPattern.lastIndex = 0;
    const match = options.readyPattern.exec(line);
    if (match && !settled) {
      settled = true;
      resolveReady(match[1] ?? match[0]);
    }
  };
  const stdout = captureLines(child.stdout, stdoutPath, inspectLine, options.redactValues);
  const stderr = captureLines(child.stderr, stderrPath, inspectLine, options.redactValues);
  const completed = (async () => {
    const [status] = await Promise.all([child.status, stdout, stderr]);
    if (!settled) {
      settled = true;
      rejectReady(
        new Error(`${options.name} exited with ${status.code} before printing its usable URL`),
      );
    }
    return status;
  })();
  const ready = withDeadline(readiness, options.timeoutMs, `${options.name} URL`);

  return {
    child,
    ready,
    completed,
    stdoutPath,
    stderrPath,
    async stop() {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        if (!isAlreadyTerminated(error)) throw error;
      }
      try {
        await withDeadline(completed, 5_000, `${options.name} shutdown`);
      } catch {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          if (!isAlreadyTerminated(error)) throw error;
        }
        await completed;
      }
    },
  };
}

export async function runCapturedCommand(options: {
  executable?: string;
  cwd: string;
  args: string[];
  environment: Record<string, string>;
  artifactRoot: string;
  name: string;
  redactValues?: readonly string[];
}): Promise<CommandRecord> {
  const stdoutPath = join(options.artifactRoot, `${options.name}.stdout.log`);
  const stderrPath = join(options.artifactRoot, `${options.name}.stderr.log`);
  const started = performance.now();
  const output = await new Deno.Command(options.executable ?? Deno.execPath(), {
    args: options.args,
    cwd: options.cwd,
    clearEnv: true,
    env: options.environment,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  await Promise.all([
    Deno.writeTextFile(
      stdoutPath,
      redactText(decoder.decode(output.stdout), options.redactValues ?? []),
    ),
    Deno.writeTextFile(
      stderrPath,
      redactText(decoder.decode(output.stderr), options.redactValues ?? []),
    ),
  ]);
  return {
    name: options.name,
    args: options.args,
    durationMs: Math.round(performance.now() - started),
    exitCode: output.code,
    stdoutPath,
    stderrPath,
  };
}

export async function initializeFixtureGit(
  projectRoot: string,
  environment: Record<string, string>,
  artifactRoot: string,
): Promise<CommandRecord[]> {
  // Deno does not proxy arbitrary git subcommands. Execute git directly, but retain the same
  // structured evidence as every public Deno command.
  const records: CommandRecord[] = [];
  for (
    const [name, args] of [
      ["fixture-git-init", ["init", "-q"]],
      ["fixture-git-add", ["add", "-A"]],
      [
        "fixture-git-commit",
        [
          "-c",
          "user.name=lofi golden path",
          "-c",
          "user.email=golden-path@invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-qm",
          "clean checkout fixture",
        ],
      ],
    ] as const
  ) {
    const stdoutPath = join(artifactRoot, `${name}.stdout.log`);
    const stderrPath = join(artifactRoot, `${name}.stderr.log`);
    const started = performance.now();
    const output = await new Deno.Command("git", {
      args: [...args],
      cwd: projectRoot,
      clearEnv: true,
      env: environment,
      stdout: "piped",
      stderr: "piped",
    }).output();
    await Promise.all([
      Deno.writeFile(stdoutPath, output.stdout),
      Deno.writeFile(stderrPath, output.stderr),
    ]);
    const record = {
      name,
      args: ["git", ...args],
      durationMs: Math.round(performance.now() - started),
      exitCode: output.code,
      stdoutPath,
      stderrPath,
    };
    records.push(record);
    if (!output.success) throw new Error(`${name} failed; see ${stderrPath}`);
  }
  return records;
}

export function reserveLocalPort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const address = listener.addr as Deno.NetAddr;
  listener.close();
  return address.port;
}

export function artifactPaths(root: string) {
  return {
    root,
    report: join(root, "report.json"),
    trace: join(root, "trace.zip"),
    screenshot: join(root, "failure.png"),
  };
}

export async function writeJourneyReport(report: JourneyReport): Promise<void> {
  await Deno.mkdir(dirname(report.artifacts.report), { recursive: true });
  await Deno.writeTextFile(report.artifacts.report, `${JSON.stringify(report, null, 2)}\n`);
}
