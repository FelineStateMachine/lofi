#!/usr/bin/env -S deno run -A

/**
 * The `deno task doctor` command: prints a value-free readiness report covering
 * the package, Deno, project layout, environment, storage, identity, sync, and
 * PWA, and exits non-zero when the project is blocked.
 *
 * @module
 */

import { doctorReport, printDoctorReport } from "../tooling/diagnostics.ts";

const report = await doctorReport();
printDoctorReport(report);
if (report.blocked) Deno.exit(1);
