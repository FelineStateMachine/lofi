#!/usr/bin/env -S deno run -A

import { createProject } from "./create_core.ts";

function usage(): never {
  console.error("usage: deno run -A jsr:@nzip/lofi/create <name>");
  Deno.exit(2);
}

if (Deno.args.length !== 1 || Deno.args[0].startsWith("-")) usage();

try {
  const result = await createProject({ cwd: Deno.cwd(), name: Deno.args[0] });
  console.log(`Created ${result.displayPath}`);
  console.log("");
  console.log("Next:");
  for (const command of result.nextCommands) console.log(`  ${command}`);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  Deno.exit(1);
}
