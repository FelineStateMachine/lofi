const entrypoints = [
  "package/runtime/mod.ts",
  "package/astro/mod.ts",
  "package/access/mod.ts",
  "package/commands/build.ts",
  "package/create.ts",
  "package/commands/dev.ts",
  "package/commands/doctor.ts",
  "package/commands/preview.ts",
  "package/preact/mod.ts",
  "package/commands/provision.ts",
  "package/recipes/file-handler.ts",
  "package/recipes/launch-handler.ts",
  "package/recipes/protocol-handler.ts",
  "package/recipes/related-app-discovery.ts",
  "package/recipes/scope-extension.ts",
  "package/recipes/web-share.ts",
  "package/testing/mod.ts",
  "package/commands/run_tests.ts",
] as const;

const command = new Deno.Command(Deno.execPath(), {
  args: ["doc", "--lint", ...entrypoints],
  stdout: "piped",
  stderr: "piped",
});
const result = await command.output();
const decoder = new TextDecoder();
const diagnostics = `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`;
const root = `${Deno.cwd()}/`;

const blocks = diagnostics.split(/(?=^error\[)/m).filter((block) => block.startsWith("error["));
const failures = blocks.filter((block) => {
  const code = block.match(/^error\[([^\]]+)\]/)?.[1];
  const locations = [...block.matchAll(/^\s*-->\s+([^:]+):\d+:\d+$/gm)].map((match) => match[1]);
  if (code === "missing-jsdoc") return locations[0]?.startsWith(`${root}package/`) ?? true;
  if (code === "private-type-ref") {
    // `deno doc` cannot currently redirect npm dependency symbols, so a public
    // Playwright, Preact, or Jazz type is reported as private even though
    // `deno publish` resolves and fast-checks it. Keep local-to-local leaks fatal.
    return locations.slice(1).some((path) => path.startsWith(`${root}package/`));
  }
  return true;
});

if (failures.length > 0) {
  console.error(failures.join("\n"));
  console.error(`Documentation lint failed with ${failures.length} local diagnostic(s).`);
  Deno.exit(1);
}

const ignored = blocks.length - failures.length;
console.log(
  `Documentation lint passed for ${entrypoints.length} JSR entrypoints` +
    (ignored > 0 ? ` (${ignored} external type-reference diagnostic(s) ignored).` : "."),
);
