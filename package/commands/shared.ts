import { doctorReport, printDoctorReport } from "../tooling/diagnostics.ts";
import { childEnvironment } from "../tooling/environment.ts";

export async function validatedCommandEnvironment(): Promise<Record<string, string>> {
  const report = await doctorReport();
  if (report.blocked || !report.validation.ok) {
    printDoctorReport(report);
    console.error(
      "error: lofi preflight found blockers; apply the printed action and rerun the command",
    );
    Deno.exit(1);
  }
  for (const warning of report.validation.warnings) console.warn(`warning: ${warning}`);
  return childEnvironment(report.validation);
}

export function exitOnFailure(exitCode: number, action: string): void {
  if (exitCode === 0) return;
  console.error(`error: ${action} failed; fix the first error above and rerun the same Deno task`);
  Deno.exit(exitCode);
}
