#!/usr/bin/env -S deno run -A

import {
  childEnvironment,
  loadEnvironment,
  serverEnvironmentNames,
} from "../tooling/environment.ts";
import { doctorReport, printDoctorReport } from "../tooling/diagnostics.ts";
import { scanSecrets, walkFiles } from "../tooling/project.ts";
import { runDeno } from "../tooling/process.ts";
import { exitOnFailure } from "./shared.ts";

const report = await doctorReport();
if (report.blocked || !report.validation.ok) {
  printDoctorReport(report);
  console.error("error: check stopped at lofi preflight; rerun `deno task check` after the action");
  Deno.exit(1);
}
const environment = childEnvironment(report.validation);
environment.LOFI_SKIP_JAZZ_MANAGED = "1";
const typedFiles = await walkFiles(Deno.cwd(), {
  extensions: new Set([".ts", ".tsx"]),
});

for (
  const [name, args] of [
    ["format", ["fmt", "--check"]],
    ["lint", ["lint"]],
    ["type", ["check", ...typedFiles]],
    ["Astro", ["run", "-A", "npm:astro@7.0.9", "check"]],
  ] as const
) {
  exitOnFailure(await runDeno(args, environment), `${name} check`);
}

const loadedEnvironment = await loadEnvironment();
const secrets = await scanSecrets(
  Object.fromEntries(serverEnvironmentNames.map((name) => [name, loadedEnvironment[name] ?? ""])),
);
if (secrets.leaks.length > 0) {
  for (const leak of secrets.leaks) {
    console.error(`error: ${leak.name} value found in ${leak.path}`);
  }
  console.error("error: secret scan failed; remove the value and rerun `deno task check`");
  Deno.exit(1);
}
console.log(`lofi check passed (4 checks, ${secrets.scanned} files secret-scanned)`);
