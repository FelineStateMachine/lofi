import { prepareLofiAstroConfig } from "./mod.ts";

// The vendored package sources under .lofi/ are served by Vite, not Deno:
// when a generated project resolves them from the published package, every
// mapped import has been rewritten to a fully qualified npm:/jsr: specifier,
// and only the alias table in the generated Astro config maps those back to
// resolvable packages. A vendored import without an alias therefore works in
// every workspace-adjacent test and fails only in a clean-room generated
// app. These tests pin the invariant statically: every specifier the
// vendored tree can produce must be covered by the alias table, and every
// aliased npm package must be materialized at config time.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type AliasTable = { regexes: RegExp[]; literals: string[] };

async function walkFiles(directory: string, collected: string[]): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) await walkFiles(path, collected);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) collected.push(path);
  }
}

function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const statements = [
    /^\s*import\s+[^"'\n]*?from\s*"([^"\n]+)"/gm,
    /^\s*export\s+[^"'\n]*?from\s*"([^"\n]+)"/gm,
    /^\s*import\s*"([^"\n]+)"/gm,
    /import\(\s*"([^"\n]+)"\s*\)/g,
  ];
  for (const pattern of statements) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

function aliasTable(configSource: string): AliasTable {
  const regexes = [...configSource.matchAll(/find:\s*\/(.+?)\/,/g)]
    .map((match) => new RegExp(match[1]));
  const literals = [...configSource.matchAll(/find:\s*"([^"\n]+)"/g)]
    .map((match) => match[1]);
  return { regexes, literals };
}

function covered(table: AliasTable, specifier: string): boolean {
  return table.literals.includes(specifier) ||
    table.regexes.some((regex) => regex.test(specifier));
}

/** Resolves a bare specifier the way the root import map (and JSR) would. */
function mapSpecifier(imports: Record<string, string>, specifier: string): string | undefined {
  const exact = imports[specifier];
  if (exact !== undefined) return exact;
  const scopeEnd = specifier.startsWith("@") ? specifier.indexOf("/") + 1 : 0;
  const slash = specifier.indexOf("/", scopeEnd);
  if (slash < 0) return undefined;
  const base = imports[specifier.slice(0, slash)];
  if (base === undefined) return undefined;
  return base + specifier.slice(slash);
}

async function vendoredInventory(): Promise<
  { table: AliasTable; configModule: string; bySpecifier: Map<string, string[]> }
> {
  const root = await Deno.makeTempDir({ dir: ".", prefix: ".lofi-alias-test-" });
  try {
    const configPath = await prepareLofiAstroConfig({ root });
    const table = aliasTable(await Deno.readTextFile(configPath));
    const files: string[] = [];
    await walkFiles(`${root}/.lofi/package`, files);
    const bySpecifier = new Map<string, string[]>();
    for (const file of files.sort()) {
      const relative = file.slice(root.length + 1);
      for (const specifier of importSpecifiers(await Deno.readTextFile(file))) {
        if (specifier.startsWith(".")) continue;
        const users = bySpecifier.get(specifier) ?? [];
        users.push(relative);
        bySpecifier.set(specifier, users);
      }
    }
    const configModule = await Deno.readTextFile(
      new URL("./mod.ts", import.meta.url),
    );
    return { table, configModule, bySpecifier };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const rootImports = (JSON.parse(
  await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
) as { imports: Record<string, string> }).imports;

Deno.test("every vendored import is covered by the generated alias table", async () => {
  const { table, bySpecifier } = await vendoredInventory();
  assert(bySpecifier.size > 0, "vendored tree produced no imports; the scan is broken");
  const misses: string[] = [];
  for (const [specifier, users] of bySpecifier) {
    const sample = users.slice(0, 3).join(", ");
    if (specifier.startsWith("@nzip/lofi")) {
      // Self-imports stay bare in development and become jsr:@nzip/lofi@<v>
      // in the published package; the table must cover both forms.
      const subpath = specifier.slice("@nzip/lofi".length);
      if (!table.literals.includes(specifier)) {
        misses.push(`${specifier} has no bare alias (used by ${sample})`);
      }
      if (!covered(table, `jsr:@nzip/lofi@9.9.9${subpath}`)) {
        misses.push(`${specifier} has no jsr:-form alias (used by ${sample})`);
      }
      continue;
    }
    const mapped = mapSpecifier(rootImports, specifier);
    if (mapped === undefined || mapped.startsWith("node:")) continue;
    if (mapped.startsWith("./") || mapped.startsWith("../")) continue;
    if (!covered(table, mapped)) {
      misses.push(
        `${specifier} rewrites to ${mapped} in the published package but no alias matches it ` +
          `(used by ${sample})`,
      );
    }
  }
  assert(
    misses.length === 0,
    `vendored imports without alias coverage; add matching { find, replacement } entries ` +
      `(and a config-time import) in package/astro/mod.ts:\n  ${misses.join("\n  ")}`,
  );
});

Deno.test("aliased npm packages used by vendored sources materialize at config time", async () => {
  const { configModule, bySpecifier } = await vendoredInventory();
  // preact reaches node_modules through the generated app's own islands and
  // jazz-tools through the config's jazzPlugin import; everything else must
  // be imported by the config module itself so npm materializes it.
  const materializedElsewhere = ["preact", "jazz-tools"];
  const misses: string[] = [];
  for (const specifier of bySpecifier.keys()) {
    if (specifier.startsWith("@nzip/lofi")) continue;
    const mapped = mapSpecifier(rootImports, specifier);
    if (mapped === undefined || !mapped.startsWith("npm:")) continue;
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    if (materializedElsewhere.includes(packageName)) continue;
    if (!configModule.includes(`import "${specifier}";`)) {
      misses.push(specifier);
    }
  }
  assert(
    misses.length === 0,
    `vendored npm imports without a config-time materialization import in ` +
      `package/astro/mod.ts:\n  ${misses.join("\n  ")}`,
  );
});
