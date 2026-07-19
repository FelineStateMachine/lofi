/**
 * Generates the Docusaurus API reference from `deno doc --json` (schema v2)
 * into `website/api-gen/`. One page per entry in {@link entrypoints}, with the
 * six CLI command wrappers sharing a single page. Run via `deno task site:api`.
 */
import { type Entrypoint, entrypoints } from "./entrypoints.ts";

// `--node` renders the lofi-node API instead: same renderer, sourced from the
// pinned checkout of FelineStateMachine/lofi-node (LOFI_NODE_DIR, default
// ../lofi-node) so pages match the ref the /node docs render from; the
// package itself is published as jsr:@nzip/lofi-node.
const NODE_MODE = Deno.args.includes("--node");
const NODE_DIR = NODE_MODE ? (Deno.env.get("LOFI_NODE_DIR") ?? "../lofi-node") : "";

const nodeEntrypoints: readonly Entrypoint[] = [
  {
    jsrName: ".",
    file: `${NODE_DIR}/mod.ts`,
    page: "node",
    title: "Sync node",
  },
  {
    jsrName: "./testing",
    file: `${NODE_DIR}/testing/mod.ts`,
    page: "testing",
    title: "Testing",
  },
];

const activeEntrypoints = NODE_MODE ? nodeEntrypoints : entrypoints;
const packageName = NODE_MODE ? "@nzip/lofi-node" : "@nzip/lofi";

const OUT_DIR = NODE_MODE ? "website/node-api-gen" : "website/api-gen";

type JsDocTag = {
  kind: string;
  name?: string;
  doc?: string;
  type?: string;
};
type JsDoc = { doc?: string; tags?: JsDocTag[] };
type TsType = {
  repr?: string;
  kind?: string;
  // deno-lint-ignore no-explicit-any
  value?: any;
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
};
type Param = {
  kind: string;
  name?: string;
  optional?: boolean;
  tsType?: TsType;
  // deno-lint-ignore no-explicit-any
  [k: string]: any;
};
type TypeParam = { name: string; constraint?: TsType; default?: TsType };
type Declaration = {
  kind: string;
  declarationKind: string;
  jsDoc?: JsDoc;
  // deno-lint-ignore no-explicit-any
  def?: any;
};
type SymbolNode = { name: string; declarations: Declaration[] };
type ModuleNodes = { module_doc?: JsDoc; symbols?: SymbolNode[] };
type DocOutput = { version: number; nodes: Record<string, ModuleNodes> };

function printType(t: TsType | undefined | null): string {
  if (!t) return "unknown";
  switch (t.kind) {
    case "keyword":
      return String(t.value ?? t.repr ?? "unknown");
    case "literal": {
      const v = t.value ?? {};
      if (v.kind === "string") return JSON.stringify(v.string);
      if (v.kind === "number") return String(v.number);
      if (v.kind === "boolean") return String(v.boolean);
      if (v.kind === "bigInt") return `${v.string}n`;
      if (v.kind === "template") {
        return t.repr ? `\`${t.repr}\`` : "`...`";
      }
      return t.repr ?? "unknown";
    }
    case "typeRef": {
      const v = t.value ?? {};
      const args: TsType[] = v.typeParams ?? [];
      const name = v.typeName ?? t.repr ?? "unknown";
      return args.length > 0 ? `${name}<${args.map(printType).join(", ")}>` : name;
    }
    case "union":
      return (t.value as TsType[]).map(printType).join(" | ");
    case "intersection":
      return (t.value as TsType[]).map(printType).join(" & ");
    case "array": {
      const inner = printType(t.value);
      return /[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
    }
    case "tuple":
      return `[${(t.value as TsType[]).map(printType).join(", ")}]`;
    case "typeOperator": {
      const v = t.value ?? {};
      return `${v.operator} ${printType(v.tsType)}`;
    }
    case "optional":
      return printType(t.value);
    case "parenthesized":
      return `(${printType(t.value)})`;
    case "rest":
      return `...${printType(t.value)}`;
    case "fnOrConstructor": {
      const v = t.value ?? {};
      const params = (v.params ?? []).map(printParam).join(", ");
      const tp = printTypeParams(v.typeParams ?? []);
      const prefix = v.constructor ? "new " : "";
      return `${prefix}${tp}(${params}) => ${printType(v.tsType)}`;
    }
    case "typeLiteral": {
      const v = t.value ?? {};
      const parts: string[] = [];
      for (const sig of v.indexSignatures ?? []) {
        parts.push(
          `[${(sig.params ?? []).map(printParam).join(", ")}]: ${printType(sig.tsType)}`,
        );
      }
      for (const p of v.properties ?? []) {
        parts.push(
          `${p.readonly ? "readonly " : ""}${p.name}${p.optional ? "?" : ""}: ${
            printType(p.tsType)
          }`,
        );
      }
      for (const m of v.methods ?? []) {
        const fd = m.functionDef ?? m;
        parts.push(
          `${m.name}${m.optional ? "?" : ""}${printTypeParams(fd.typeParams ?? [])}(${
            (fd.params ?? m.params ?? []).map(printParam).join(", ")
          }): ${printType(fd.returnType ?? m.returnType)}`,
        );
      }
      if (parts.length === 0) return "Record<never, never>";
      return `{ ${parts.join("; ")} }`;
    }
    case "conditional": {
      const v = t.value ?? {};
      return `${printType(v.checkType)} extends ${printType(v.extendsType)} ? ${
        printType(v.trueType)
      } : ${printType(v.falseType)}`;
    }
    case "indexedAccess": {
      const v = t.value ?? {};
      return `${printType(v.objType)}[${printType(v.indexType)}]`;
    }
    case "typeQuery":
      return `typeof ${t.value}`;
    case "typePredicate": {
      const v = t.value ?? {};
      const name = v.param?.name ?? "value";
      const asserts = v.asserts ? "asserts " : "";
      return v.type ? `${asserts}${name} is ${printType(v.type)}` : `${asserts}${name}`;
    }
    case "importType": {
      const v = t.value ?? {};
      const qualifier = v.qualifier ? `.${v.qualifier}` : "";
      return `import(${JSON.stringify(v.specifier ?? "?")})${qualifier}`;
    }
    case "infer":
      return `infer ${t.value?.typeParam?.name ?? "T"}`;
    case "this":
      return "this";
    case "mapped":
      return t.repr && t.repr.length > 0 ? t.repr : "{ [mapped type] }";
    default:
      return t.repr && t.repr.length > 0 ? t.repr : "unknown";
  }
}

function printParam(p: Param): string {
  switch (p.kind) {
    case "identifier":
      return `${p.name}${p.optional ? "?" : ""}${p.tsType ? `: ${printType(p.tsType)}` : ""}`;
    case "rest":
      return `...${printParam(p.arg)}${p.tsType ? `: ${printType(p.tsType)}` : ""}`;
    case "assign": {
      const left = printParam(p.left);
      return p.left?.tsType || !p.tsType ? left : `${left}: ${printType(p.tsType)}`;
    }
    case "object":
      return `{ ${(p.props ?? []).map((prop: Param) => prop.name ?? "...").join(", ")} }${
        p.tsType ? `: ${printType(p.tsType)}` : ""
      }`;
    case "array":
      return `[...]${p.tsType ? `: ${printType(p.tsType)}` : ""}`;
    default:
      return p.name ?? "arg";
  }
}

function printTypeParams(typeParams: TypeParam[]): string {
  if (!typeParams || typeParams.length === 0) return "";
  const parts = typeParams.map((tp) => {
    let out = tp.name;
    if (tp.constraint) out += ` extends ${printType(tp.constraint)}`;
    if (tp.default) out += ` = ${printType(tp.default)}`;
    return out;
  });
  return `<${parts.join(", ")}>`;
}

// deno-lint-ignore no-explicit-any
function functionSignature(name: string, def: any, isAsync = false): string {
  const asyncPrefix = def?.isAsync || isAsync ? "async " : "";
  const params = (def?.params ?? []).map(printParam).join(", ");
  const ret = def?.returnType ? `: ${printType(def.returnType)}` : "";
  return `${asyncPrefix}function ${name}${printTypeParams(def?.typeParams ?? [])}(${params})${ret}`;
}

// deno-lint-ignore no-explicit-any
function classSignature(name: string, def: any): string {
  const lines: string[] = [];
  let head = `class ${name}${printTypeParams(def?.typeParams ?? [])}`;
  if (def?.extends) head += ` extends ${def.extends}`;
  if (def?.implements?.length) {
    head += ` implements ${def.implements.map(printType).join(", ")}`;
  }
  lines.push(`${head} {`);
  for (const ctor of def?.constructors ?? []) {
    lines.push(
      `  constructor(${(ctor.params ?? []).map(printParam).join(", ")});`,
    );
  }
  for (const prop of def?.properties ?? []) {
    const mods = [
      prop.isStatic ? "static " : "",
      prop.readonly ? "readonly " : "",
    ].join("");
    lines.push(
      `  ${mods}${prop.name}${prop.optional ? "?" : ""}${
        prop.tsType ? `: ${printType(prop.tsType)}` : ""
      };`,
    );
  }
  for (const method of def?.methods ?? []) {
    const fd = method.functionDef ?? {};
    const mods = method.isStatic ? "static " : "";
    const accessor = method.kind === "getter" ? "get " : method.kind === "setter" ? "set " : "";
    const params = (fd.params ?? []).map(printParam).join(", ");
    const ret = fd.returnType ? `: ${printType(fd.returnType)}` : "";
    lines.push(
      `  ${mods}${accessor}${method.name}${printTypeParams(fd.typeParams ?? [])}(${params})${ret};`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

// deno-lint-ignore no-explicit-any
function interfaceSignature(name: string, def: any): string {
  const lines: string[] = [];
  let head = `interface ${name}${printTypeParams(def?.typeParams ?? [])}`;
  if (def?.extends?.length) {
    head += ` extends ${def.extends.map(printType).join(", ")}`;
  }
  lines.push(`${head} {`);
  for (const prop of def?.properties ?? []) {
    lines.push(
      `  ${prop.readonly ? "readonly " : ""}${prop.name}${prop.optional ? "?" : ""}${
        prop.tsType ? `: ${printType(prop.tsType)}` : ""
      };`,
    );
  }
  for (const method of def?.methods ?? []) {
    const params = (method.params ?? []).map(printParam).join(", ");
    const ret = method.returnType ? `: ${printType(method.returnType)}` : "";
    lines.push(
      `  ${method.name}${method.optional ? "?" : ""}${
        printTypeParams(method.typeParams ?? [])
      }(${params})${ret};`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

// deno-lint-ignore no-explicit-any
function typeAliasSignature(name: string, def: any): string {
  const printed = printTypeAliasBody(def?.tsType);
  return `type ${name}${printTypeParams(def?.typeParams ?? [])} = ${printed};`;
}

function printTypeAliasBody(t: TsType | undefined): string {
  if (t?.kind === "typeLiteral") {
    const v = t.value ?? {};
    const parts: string[] = [];
    for (const sig of v.indexSignatures ?? []) {
      parts.push(
        `  [${(sig.params ?? []).map(printParam).join(", ")}]: ${printType(sig.tsType)};`,
      );
    }
    for (const p of v.properties ?? []) {
      parts.push(
        `  ${p.readonly ? "readonly " : ""}${p.name}${p.optional ? "?" : ""}: ${
          printType(p.tsType)
        };`,
      );
    }
    for (const m of v.methods ?? []) {
      const fd = m.functionDef ?? m;
      parts.push(
        `  ${m.name}${m.optional ? "?" : ""}${printTypeParams(fd.typeParams ?? [])}(${
          (fd.params ?? m.params ?? []).map(printParam).join(", ")
        }): ${printType(fd.returnType ?? m.returnType)};`,
      );
    }
    if (parts.length > 0) return `{\n${parts.join("\n")}\n}`;
  }
  if (t?.kind === "union" && (t.value as TsType[]).length > 3) {
    return `\n  | ${(t.value as TsType[]).map(printType).join("\n  | ")}`;
  }
  return printType(t);
}

// deno-lint-ignore no-explicit-any
function variableSignature(name: string, def: any): string {
  const keyword = def?.kind ?? "const";
  return `${keyword} ${name}${def?.tsType ? `: ${printType(def.tsType)}` : ""};`;
}

function declarationSignature(name: string, dec: Declaration): string | null {
  switch (dec.kind) {
    case "function":
      return functionSignature(name, dec.def);
    case "class":
      return classSignature(name, dec.def);
    case "interface":
      return interfaceSignature(name, dec.def);
    case "typeAlias":
      return typeAliasSignature(name, dec.def);
    case "variable":
      return variableSignature(name, dec.def);
    case "enum":
      // deno-lint-ignore no-explicit-any
      return `enum ${name} { ${(dec.def?.members ?? []).map((m: any) => m.name).join(", ")} }`;
    case "namespace":
      return `namespace ${name}`;
    default:
      return null;
  }
}

/** Converts `{@link X}` / `{@linkcode X}` JSDoc tags to plain Markdown. */
function renderJsDocText(text: string): string {
  return text.replace(
    /\{@link(?:code|plain)?\s+([^}|\s]+)(?:\s*\|\s*([^}]+))?\}/g,
    (_match, target: string, label?: string) => {
      const display = (label ?? target).trim();
      if (/^https?:\/\//.test(target)) return `[${display}](${target})`;
      return `\`${display}\``;
    },
  );
}

function renderJsDoc(jsDoc: JsDoc | undefined): string {
  if (!jsDoc) return "";
  const out: string[] = [];
  if (jsDoc.doc) out.push(renderJsDocText(jsDoc.doc.trim()));
  const tags = jsDoc.tags ?? [];
  const params = tags.filter((tag) => tag.kind === "param" && tag.doc);
  if (params.length > 0) {
    const rows = [
      "| Parameter | Description |",
      "| --- | --- |",
      ...params.map((tag) =>
        `| \`${tag.name}\` | ${renderJsDocText(tag.doc ?? "").replaceAll("\n", " ")} |`
      ),
    ];
    out.push(rows.join("\n"));
  }
  for (const tag of tags) {
    if (tag.kind === "return" && tag.doc) {
      out.push(`**Returns:** ${renderJsDocText(tag.doc)}`);
    }
    if (tag.kind === "deprecated") {
      out.push(`**Deprecated.** ${renderJsDocText(tag.doc ?? "")}`.trim());
    }
    if (tag.kind === "default") {
      out.push(`**Default:** \`${tag.doc ?? tag.type ?? ""}\``);
    }
  }
  for (const tag of tags) {
    if (tag.kind === "example" && tag.doc) {
      const body = tag.doc.trim();
      const rendered = body.includes("```") ? body : `\`\`\`ts\n${body}\n\`\`\``;
      out.push(`**Example**\n\n${renderJsDocText(rendered)}`);
    }
  }
  return out.join("\n\n");
}

async function docModule(file: string): Promise<ModuleNodes> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", file],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    throw new Error(
      `deno doc --json ${file} failed:\n${new TextDecoder().decode(result.stderr)}`,
    );
  }
  const parsed = JSON.parse(
    new TextDecoder().decode(result.stdout),
  ) as DocOutput;
  if (parsed.version !== 2) {
    throw new Error(
      `deno doc --json for ${file} returned schema v${parsed.version}; expected v2.`,
    );
  }
  const modules = Object.values(parsed.nodes);
  if (modules.length === 0) {
    throw new Error(`deno doc --json ${file} returned no modules.`);
  }
  return modules[0];
}

const KIND_LABEL: Record<string, string> = {
  function: "function",
  class: "class",
  interface: "interface",
  typeAlias: "type",
  variable: "const",
  enum: "enum",
  namespace: "namespace",
};

function renderSymbol(symbol: SymbolNode): string {
  const out: string[] = [];
  const kinds = [
    ...new Set(
      symbol.declarations.map((dec) => KIND_LABEL[dec.kind] ?? dec.kind),
    ),
  ];
  // h2 keeps the heading hierarchy sequential under the page h1
  out.push(`## ${symbol.name}`);
  out.push(`<sup>${kinds.join(", ")}</sup>`);
  const signatures = symbol.declarations
    .map((dec) => declarationSignature(symbol.name, dec))
    .filter((sig): sig is string => sig !== null);
  if (signatures.length > 0) {
    out.push(`\`\`\`ts\n${signatures.join("\n\n")}\n\`\`\``);
  }
  const jsDoc = symbol.declarations.find((dec) => dec.jsDoc)?.jsDoc;
  const rendered = renderJsDoc(jsDoc);
  if (rendered) out.push(rendered);
  return out.join("\n\n");
}

function symbolSortKey(symbol: SymbolNode): [number, string] {
  const kindRank =
    symbol.declarations.some((dec) =>
        dec.kind === "function" || dec.kind === "class" ||
        dec.kind === "variable"
      )
      ? 0
      : 1;
  return [kindRank, symbol.name.toLowerCase()];
}

function moduleSummary(moduleDoc: JsDoc | undefined): string {
  const doc = moduleDoc?.doc ?? "";
  const firstSentence = doc.split(/\n\s*\n/)[0]?.replaceAll("\n", " ").trim() ??
    "";
  return renderJsDocText(firstSentence);
}

type PageGroup = {
  page: string;
  position: number;
  entries: typeof entrypoints[number][];
};

const pageOrder = NODE_MODE
  ? ["node", "testing"]
  : ["runtime", "astro", "access", "preact", "testing", "cli"];
const groups = new Map<string, PageGroup>();
for (const entry of activeEntrypoints) {
  const group = groups.get(entry.page) ?? {
    page: entry.page,
    position: entry.page.startsWith("recipes/")
      ? 1 +
        [...activeEntrypoints.filter((e) => e.page.startsWith("recipes/"))]
          .findIndex((e) => e.page === entry.page)
      : 1 + pageOrder.indexOf(entry.page),
    entries: [],
  };
  group.entries.push(entry);
  groups.set(entry.page, group);
}

const denoJson = JSON.parse(
  await Deno.readTextFile(NODE_MODE ? `${NODE_DIR}/deno.json` : "deno.json"),
) as {
  version: string;
  description: string;
};

await Deno.mkdir(NODE_MODE ? OUT_DIR : `${OUT_DIR}/recipes`, {
  recursive: true,
});

const indexRows: string[] = [];
let totalSymbols = 0;

for (const group of groups.values()) {
  const sections: string[] = [];
  let pageTitle: string;
  if (group.page === "cli") {
    pageTitle = "CLI commands";
    sections.push(
      "Executable entrypoints run with `deno run` (the generated project wires them up as `deno task` commands). They expose behavior, not exported symbols.",
    );
  } else {
    pageTitle = group.entries[0].title;
  }

  for (const entry of group.entries) {
    const module = await docModule(entry.file);
    const symbols = (module.symbols ?? []).filter((symbol) =>
      symbol.declarations.some((dec) => dec.declarationKind === "export")
    );
    symbols.sort((a, b) => {
      const [rankA, nameA] = symbolSortKey(a);
      const [rankB, nameB] = symbolSortKey(b);
      return rankA - rankB || nameA.localeCompare(nameB);
    });
    const isCommand = group.page === "cli";
    if (!isCommand && symbols.length === 0) {
      throw new Error(
        `No exported symbols found for ${entry.file}; refusing to emit empty page.`,
      );
    }
    if (!module.module_doc?.doc && symbols.length === 0) {
      throw new Error(`No module doc or symbols for ${entry.file}.`);
    }
    totalSymbols += symbols.length;

    const jsrSpecifier = entry.jsrName === "."
      ? packageName
      : `${packageName}${entry.jsrName.slice(1)}`;
    if (isCommand) {
      sections.push(`## ${entry.title}`);
      sections.push(`\`\`\`sh\ndeno run -A jsr:${jsrSpecifier}\n\`\`\``);
      if (module.module_doc?.doc) {
        sections.push(renderJsDocText(module.module_doc.doc.trim()));
      }
    } else {
      sections.push(`\`\`\`ts\nimport * as mod from "jsr:${jsrSpecifier}";\n\`\`\``);
      if (module.module_doc?.doc) {
        sections.push(renderJsDocText(module.module_doc.doc.trim()));
      }
      sections.push(...symbols.map(renderSymbol));
    }
    indexRows.push(
      `| [\`${jsrSpecifier}\`](./${group.page}.md${isCommand ? `#${entry.title}` : ""}) | ${
        moduleSummary(module.module_doc)
      } |`,
    );
  }

  const frontmatter = [
    "---",
    `title: ${JSON.stringify(pageTitle)}`,
    `sidebar_position: ${group.position}`,
    "---",
  ].join("\n");
  const body = `${frontmatter}\n\n# ${pageTitle}\n\n${sections.join("\n\n")}\n`;
  await Deno.writeTextFile(`${OUT_DIR}/${group.page}.md`, body);
}

const indexIntro = NODE_MODE
  ? `Generated from the JSDoc of [\`@nzip/lofi-node\`](https://jsr.io/@nzip/lofi-node) v${denoJson.version}.
${denoJson.description}`
  : `Generated from the JSDoc of [\`@nzip/lofi\`](https://jsr.io/@nzip/lofi) v${denoJson.version}.
${denoJson.description}`;

const index = `---
title: "API reference"
sidebar_position: 0
slug: /
---

# ${NODE_MODE ? "lofi-node API reference" : "API reference"}

${indexIntro}

| Export | Summary |
| --- | --- |
${indexRows.join("\n")}
`;
await Deno.writeTextFile(`${OUT_DIR}/index.md`, index);

if (!NODE_MODE) {
  await Deno.writeTextFile(
    `${OUT_DIR}/recipes/_category_.json`,
    `${
      JSON.stringify(
        { label: "Recipes", position: 8, collapsed: true },
        null,
        2,
      )
    }\n`,
  );
}

console.log(
  `Generated ${groups.size + 1} API pages (${totalSymbols} exported symbols) into ${OUT_DIR}/.`,
);
