import { runJourney } from "./golden_path.ts";

try {
  const cloud = Deno.args.includes("--cloud");
  const report = await runJourney({
    source: "checkout",
    environmentMode: cloud ? "cloud-from-root" : "isolated-local",
  });
  console.log(`lofi golden path: passed (${report.artifacts.report})`);
} catch (error) {
  console.error(`lofi golden path: failed: ${error instanceof Error ? error.message : error}`);
  console.error(
    Deno.args.includes("--cloud")
      ? "rerun: deno task test:golden:checkout -- --cloud"
      : "rerun: deno task test:golden:checkout",
  );
  Deno.exit(1);
}
