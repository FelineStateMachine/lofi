#!/usr/bin/env -S deno run -A

import { runDeno } from "../tooling/process.ts";
import { exitOnFailure, validatedCommandEnvironment } from "./shared.ts";

const environment = await validatedCommandEnvironment();
const started = performance.now();
const exitCode = await runDeno(
  ["test", "--allow-read", "--allow-write=.", "src/_lofi", "tests"],
  environment,
);
exitOnFailure(exitCode, "local-first test suite; retained browser artifacts use test-results/");
console.log(
  `lofi test passed (${Math.round(performance.now() - started)}ms; artifacts: test-results/)`,
);
