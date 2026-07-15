const INTERNAL_ENV = "spikes/jazz2-baseline/.env";
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

const [mode, ...viteArgs] = Deno.args;
if (mode !== "local" && mode !== "cloud") {
  console.error("usage: run_jazz2_spike.ts <local|cloud> [vite options]");
  Deno.exit(2);
}

await ensureStableLocalAppId();

const args = [
  "run",
  ...(mode === "cloud" ? ["--env-file=.env"] : []),
  "-A",
  "npm:vite@8.0.1",
  "spikes/jazz2-baseline",
  "--config",
  "spikes/jazz2-baseline/vite.config.ts",
  "--host",
  "127.0.0.1",
  ...viteArgs,
];

const child = new Deno.Command(Deno.execPath(), {
  args,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

const status = await child.status;
Deno.exit(status.code);
