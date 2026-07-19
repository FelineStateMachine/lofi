/**
 * Helpers shared by the lofi command entrypoints: the doctor-gated command
 * environment and a fail-fast exit for child-process results.
 *
 * @module
 */

import { doctorReport, printDoctorReport } from "../tooling/diagnostics.ts";
import { childEnvironment } from "../tooling/environment.ts";

/**
 * Run the doctor preflight and return the validated environment for child
 * processes. Prints the doctor report and exits the process when a blocker is
 * found; warnings are printed and the command proceeds.
 *
 * @returns The environment variables the command's child processes receive.
 */
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

/**
 * Return when `exitCode` is zero; otherwise point at the failed action and
 * exit the process with the same code.
 *
 * @param exitCode The child process's exit code.
 * @param action The name of the step, used in the failure message.
 */
export function exitOnFailure(exitCode: number, action: string): void {
  if (exitCode === 0) return;
  console.error(`error: ${action} failed; fix the first error above and rerun the same Deno task`);
  Deno.exit(exitCode);
}
