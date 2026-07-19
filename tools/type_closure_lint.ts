/**
 * Entry type closure lint. For every JSR entrypoint in the deno.json export
 * map, every locally-declared type referenced in an exported symbol's public
 * signature must itself be exported from that same entrypoint. A consumer who
 * imports `RuntimeDiagnostics` from `.` must be able to name the types inside
 * it (e.g. `SharedFieldAlert`) from `.` as well, not hunt through submodules.
 *
 * `deno doc --lint` only flags module-private references; a type exported from
 * its declaring submodule but not re-exported from the entry passes that check
 * while still leaving a hole in the entry's surface. This lint closes it.
 *
 * References that resolve outside `package/` (DOM lib, TypeScript built-ins,
 * npm dependencies) and generic type parameters are ignored.
 *
 * @module
 */

type DocLocation = { filename: string; line: number };

type TypeRefResolution =
  | { kind: "typeParam" }
  | { kind: "local" }
  | { kind: "import"; specifier: string; name: string };

type DocDeclaration = {
  location: DocLocation;
  declarationKind: string;
  kind: string;
};

type DocSymbol = { name: string; declarations: DocDeclaration[] };

type DocOutput = { nodes: Record<string, { symbols?: DocSymbol[] }> };

/** A type name referenced somewhere inside one exported symbol's signature. */
type TypeReference = {
  /** Exported symbol whose signature contains the reference. */
  symbol: string;
  /** Referenced type name as written (root identifier). */
  name: string;
  /** Module that contains the referencing declaration. */
  declFile: string;
  resolution: TypeRefResolution | undefined;
  /**
   * References without resolution metadata (`extends` clauses, `typeof`
   * queries) only count when the name is declared in `declFile` itself;
   * otherwise they are ambient or imported-external and are skipped.
   */
  requireLocalDecl: boolean;
};

/**
 * Suppressions a human has judged to be false positives. Keys are
 * `"<entry> <type-name>"`; values explain why the entry is exempt.
 */
const allowlist: ReadonlyMap<string, string> = new Map([]);

const root = `${Deno.cwd()}/`;
const rootUrl = new URL(`file://${root}`);
const packagePrefix = new URL("package/", rootUrl).href;

async function runDoc(args: string[]): Promise<DocOutput> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    console.error(new TextDecoder().decode(result.stderr));
    console.error(`deno doc --json failed for: ${args.join(" ")}`);
    Deno.exit(1);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

/**
 * Walks a documentation node collecting referenced type names: `typeRef`
 * nodes (unions, tuples, mapped, conditional, indexed-access, and function
 * types all bottom out here), `typeof` queries, and string-typed class
 * `extends` clauses. Skips `private` class members and JSDoc subtrees, which
 * are not part of the public signature.
 */
function collectReferences(
  value: unknown,
  symbol: string,
  declFile: string,
  out: TypeReference[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, symbol, declFile, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (node.accessibility === "private") return;
  if (node.kind === "typeRef") {
    const ref = node.value as { typeName?: string; resolution?: TypeRefResolution } | undefined;
    if (ref?.typeName) {
      out.push({
        symbol,
        name: ref.typeName.split(".")[0],
        declFile,
        resolution: ref.resolution,
        requireLocalDecl: false,
      });
    }
  } else if (node.kind === "typeQuery" && typeof node.value === "string") {
    out.push({
      symbol,
      name: node.value.split(".")[0],
      declFile,
      resolution: undefined,
      requireLocalDecl: true,
    });
  }
  if (typeof node.extends === "string") {
    // Class defs carry `extends` as a bare superclass name (interface
    // `extends` is an array of types and recurses normally).
    out.push({
      symbol,
      name: node.extends,
      declFile,
      resolution: undefined,
      requireLocalDecl: true,
    });
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "jsDoc" || key === "location") continue;
    collectReferences(child, symbol, declFile, out);
  }
}

/** Lazily built per-module map of declared symbol name → declaration line. */
const declarationCache = new Map<string, Promise<Map<string, number>>>();

function declarationsIn(fileUrl: string): Promise<Map<string, number>> {
  let cached = declarationCache.get(fileUrl);
  if (!cached) {
    cached = runDoc(["--private", fileUrl]).then((doc) => {
      const map = new Map<string, number>();
      for (const symbol of doc.nodes[fileUrl]?.symbols ?? []) {
        const line = symbol.declarations[0]?.location.line;
        if (line !== undefined && !map.has(symbol.name)) map.set(symbol.name, line);
      }
      return map;
    });
    declarationCache.set(fileUrl, cached);
  }
  return cached;
}

/**
 * Resolves a reference to the module expected to declare it, or `null` when
 * the reference is a generic type parameter or resolves outside `package/`.
 * `names` lists identifiers that satisfy the closure when exported from the
 * entry (the local alias plus, for re-imports, the original name).
 */
function resolveTarget(ref: TypeReference): { file: string; names: string[] } | null {
  const { resolution } = ref;
  if (resolution?.kind === "typeParam") return null;
  if (resolution?.kind === "local" || resolution === undefined) {
    if (!ref.declFile.startsWith(packagePrefix)) return null;
    if (resolution === undefined && !ref.requireLocalDecl) return null; // ambient (DOM/built-in)
    return { file: ref.declFile, names: [ref.name] };
  }
  if (!resolution.specifier.startsWith(".")) return null; // bare specifier: npm/jsr dependency
  const target = new URL(resolution.specifier, ref.declFile).href;
  if (!target.startsWith(packagePrefix)) return null;
  return { file: target, names: [ref.name, resolution.name] };
}

const denoConfig = JSON.parse(await Deno.readTextFile(new URL("deno.json", rootUrl)));
const entries = Object.entries(denoConfig.exports as Record<string, string>)
  .map(([jsrName, path]) => ({ jsrName, url: new URL(path, rootUrl).href }));

const doc = await runDoc(entries.map((entry) => entry.url));
const violations: string[] = [];
let emptyEntries = 0;

for (const entry of entries) {
  const symbols = doc.nodes[entry.url]?.symbols ?? [];
  if (symbols.length === 0) {
    emptyEntries += 1;
    continue;
  }
  const exported = new Set(symbols.map((symbol) => symbol.name));
  const references: TypeReference[] = [];
  for (const symbol of symbols) {
    for (const declaration of symbol.declarations) {
      collectReferences(declaration, symbol.name, declaration.location.filename, references);
    }
  }
  const seen = new Set<string>();
  for (const ref of references) {
    if (exported.has(ref.name)) continue;
    if (allowlist.has(`${entry.jsrName} ${ref.name}`)) continue;
    const target = resolveTarget(ref);
    if (target === null || target.names.some((name) => exported.has(name))) continue;
    const key = `${ref.symbol} ${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const declared = await declarationsIn(target.file);
    const line = declared.get(target.names.at(-1) ?? ref.name);
    if (line === undefined && ref.requireLocalDecl) continue; // ambient or imported-external
    const path = target.file.slice(rootUrl.href.length);
    violations.push(
      `${entry.jsrName}  ${ref.symbol}  →  ${ref.name} (declared at ${path}:${line ?? "?"})`,
    );
  }
}

if (violations.length > 0) {
  console.error(violations.sort().join("\n"));
  console.error(`Entry type closure failed with ${violations.length} unexported type(s).`);
  Deno.exit(1);
}

console.log(
  `Entry type closure holds for ${entries.length} JSR entrypoints` +
    (emptyEntries > 0 ? ` (${emptyEntries} export no symbols).` : "."),
);
