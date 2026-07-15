#!/usr/bin/env -S deno run -A

import { doctorReport, printDoctorReport } from "../tooling/diagnostics.ts";

const report = await doctorReport();
printDoctorReport(report);
if (report.blocked) Deno.exit(1);
