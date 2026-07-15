import { environmentNames, validateEnvironment } from "./env_contract.ts";
import { loadEnvironment } from "./load_env.ts";

const INTERNAL_ENV = "apps/reference/.env";
const LOCAL_APP_ID = "00000000-0000-0000-0000-00000000f153";

async function ensureStableLocalAppId() {
  let content = "";
  try {
    content = await Deno.readTextFile(INTERNAL_ENV);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (/^VITE_JAZZ_APP_ID=/m.test(content)) return;
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await Deno.writeTextFile(
    INTERNAL_ENV,
    `${content}${separator}VITE_JAZZ_APP_ID=${LOCAL_APP_ID}\n`,
  );
}

async function forward(stream: ReadableStream<Uint8Array>, target: WritableStream<Uint8Array>) {
  await stream.pipeTo(target, { preventClose: true });
}

async function run(args: string[], env: Record<string, string>): Promise<number> {
  const child = new Deno.Command(Deno.execPath(), {
    args,
    env,
    stdin: "inherit",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const forwardSignal = (signal: Deno.Signal) => {
    try {
      child.kill(signal);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  const onInterrupt = () => forwardSignal("SIGINT");
  const onTerminate = () => forwardSignal("SIGTERM");
  Deno.addSignalListener("SIGINT", onInterrupt);
  Deno.addSignalListener("SIGTERM", onTerminate);
  const output = forward(child.stdout, Deno.stdout.writable);
  const errors = forward(child.stderr, Deno.stderr.writable);
  try {
    const [status] = await Promise.all([child.status, output, errors]);
    return status.code;
  } finally {
    Deno.removeSignalListener("SIGINT", onInterrupt);
    Deno.removeSignalListener("SIGTERM", onTerminate);
  }
}

async function routeCount(): Promise<number> {
  let count = 0;
  async function visit(path: string) {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) await visit(child);
      else if (entry.isFile && entry.name.endsWith(".html")) count += 1;
    }
  }
  try {
    await visit("apps/reference/dist");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return count;
}

async function buildFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string) {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) await visit(child);
      else if (entry.isFile) files.push(`./${child.slice(root.length + 1)}`);
    }
  }
  await visit(root);
  return files.sort();
}

const command = Deno.args[0];
if (command !== "dev" && command !== "build") {
  console.error("usage: run_reference.ts <dev|build>");
  Deno.exit(2);
}

const environment = await loadEnvironment();
const validation = validateEnvironment(environment);
if (!validation.ok) {
  console.error("lofi environment mode: invalid");
  for (const error of validation.errors) console.error(`error: ${error}`);
  Deno.exit(1);
}
for (const warning of validation.warnings) console.warn(`warning: ${warning}`);
await ensureStableLocalAppId();

const validatedEnvironment = Object.fromEntries(
  environmentNames
    .map((name) => [name, environment[name]?.trim() ?? ""] as const)
    .filter(([, value]) => value.length > 0),
);
const childEnvironment = { ...validatedEnvironment };
if (command === "dev") childEnvironment.ASTRO_DEV_BACKGROUND = "1";
if (command === "build") {
  childEnvironment.LOFI_SKIP_JAZZ_MANAGED = "1";
  childEnvironment.JAZZ_ADMIN_SECRET = "";
  childEnvironment.BACKEND_SECRET = "";
}

const forwardedArgs = Deno.args.slice(1).filter((argument, index) => {
  return !(index === 0 && argument === "--");
});

if (command === "dev") {
  console.log("lofi dev");
  console.log("Storage: persistent/OPFS requested; browser diagnosis in UI");
  console.log("Identity: device-local key; passkey backup blocked by alpha security review");
  console.log(
    `Sync: ${
      validation.mode === "cloud-configured" ? "managed configured" : "local development server"
    }`,
  );
  console.log("PWA: development service worker disabled");
}

const exitCode = await run(
  [
    "run",
    "-A",
    "npm:astro@7.0.9",
    command,
    "--root",
    "apps/reference",
    ...forwardedArgs,
  ],
  childEnvironment,
);
if (exitCode !== 0) Deno.exit(exitCode);

if (command === "build") {
  const revision = new TextDecoder().decode(
    (await new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      stdout: "piped",
    }).output()).stdout,
  ).trim();
  await Deno.writeTextFile(
    "apps/reference/dist/lofi-build.json",
    `${JSON.stringify({ revision, builtAt: new Date().toISOString() })}\n`,
  );
  const serviceWorkerPath = "apps/reference/dist/sw.js";
  const serviceWorker = await Deno.readTextFile(serviceWorkerPath);
  await Deno.writeTextFile(
    serviceWorkerPath,
    serviceWorker.replace("__LOFI_BUILD_REVISION__", revision),
  );
  const precache = (await buildFiles("apps/reference/dist"))
    .filter((path) => path !== "./lofi-precache.json")
    .map((path) => path === "./index.html" ? "./" : path);
  precache.push("./lofi-precache.json");
  await Deno.writeTextFile(
    "apps/reference/dist/lofi-precache.json",
    `${JSON.stringify(precache.sort())}\n`,
  );
  const scanCode = await run(
    ["task", "check:secrets"],
    validatedEnvironment,
  );
  if (scanCode !== 0) Deno.exit(scanCode);
  console.log(`lofi build: apps/reference/dist (${await routeCount()} routes, ${revision})`);
}
