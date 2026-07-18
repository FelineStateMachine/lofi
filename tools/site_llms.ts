/**
 * Generates `llms.txt` and `llms-full.txt` into `website/static/` from the same
 * sources the docs site builds from: `website/docs-manifest.json` for the
 * user docs (order and inclusion shared with `website/sidebars.ts`) and the
 * pages `tools/api_docs.ts` emitted into `website/api-gen/`. Run via
 * `deno task site:llms`, after `deno task site:api`.
 */

const OUT_DIR = "website/static";
const API_DIR = "website/api-gen";

type ManifestItem = { id: string; label: string };
type ManifestSection = {
  label: string | null;
  indexId?: string;
  items: ManifestItem[];
};
type Manifest = { siteUrl: string; sections: ManifestSection[] };

const manifest = JSON.parse(
  await Deno.readTextFile("website/docs-manifest.json"),
) as Manifest;
const denoJson = JSON.parse(await Deno.readTextFile("deno.json")) as {
  version: string;
  description: string;
};
const siteUrl = Deno.env.get("SITE_URL") ?? manifest.siteUrl;

/** `README` ids collapse to their directory index route, matching Docusaurus. */
function docUrl(id: string): string {
  const slug = id === "README" ? "" : id.endsWith("/README") ? id.slice(0, -"/README".length) : id;
  return slug === "" ? `${siteUrl}/docs` : `${siteUrl}/docs/${slug}`;
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---\n", 4);
  return end === -1 ? markdown : markdown.slice(end + "\n---\n".length);
}

function firstHeading(markdown: string): string | null {
  return stripFrontmatter(markdown).match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

type DocEntry = { title: string; url: string; sourcePath: string };
type Section = { label: string; docs: DocEntry[] };

const sections: Section[] = [];
for (const section of manifest.sections) {
  const docs: DocEntry[] = [];
  const ids = [
    ...(section.indexId ? [{ id: section.indexId, label: section.label ?? "" }] : []),
    ...section.items,
  ];
  for (const item of ids) {
    const sourcePath = `docs/${item.id}.md`;
    const markdown = await Deno.readTextFile(sourcePath);
    docs.push({
      title: firstHeading(markdown) ?? item.label,
      url: docUrl(item.id),
      sourcePath,
    });
  }
  sections.push({ label: section.label ?? "Documentation", docs });
}

// API pages in sidebar order: index first, then top-level pages by
// sidebar_position, then recipes.
type ApiEntry = { title: string; url: string; sourcePath: string; position: number };
const apiEntries: ApiEntry[] = [];
async function collectApiDir(dir: string, urlPrefix: string): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      await collectApiDir(`${dir}/${entry.name}`, `${urlPrefix}/${entry.name}`);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const sourcePath = `${dir}/${entry.name}`;
    const markdown = await Deno.readTextFile(sourcePath);
    const stem = entry.name.slice(0, -".md".length);
    const position = Number(markdown.match(/^sidebar_position:\s*(\d+)$/m)?.[1] ?? 99);
    const url = stem === "index" ? urlPrefix : `${urlPrefix}/${stem}`;
    apiEntries.push({
      title: firstHeading(markdown) ?? stem,
      url,
      sourcePath,
      position: dir === API_DIR ? position : 100 + position,
    });
  }
}
try {
  await collectApiDir(API_DIR, `${siteUrl}/api`);
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
  console.error(`Missing ${API_DIR}; run \`deno task site:api\` first.`);
  Deno.exit(1);
}
if (apiEntries.length === 0) {
  console.error(`No API pages found in ${API_DIR}; run \`deno task site:api\` first.`);
  Deno.exit(1);
}
apiEntries.sort((a, b) => a.position - b.position || a.url.localeCompare(b.url));

// llms.txt: short index with absolute links, per https://llmstxt.org.
const shortLines: string[] = [
  "# lofi",
  "",
  `> ${denoJson.description}`,
  "",
  `lofi is published on JSR as \`@nzip/lofi\` (v${denoJson.version}).`,
  `This file indexes the documentation deployed at ${siteUrl} for this exact version.`,
  `The full documentation corpus is available at ${siteUrl}/llms-full.txt.`,
  `The self-hosted sync node (lofi-node) is indexed separately at ${siteUrl}/node/llms.txt` +
  ` (full corpus: ${siteUrl}/node/llms-full.txt).`,
  "",
];
for (const section of sections) {
  shortLines.push(`## ${section.label}`, "");
  for (const doc of section.docs) {
    shortLines.push(`- [${doc.title}](${doc.url})`);
  }
  shortLines.push("");
}
shortLines.push("## API reference", "");
for (const entry of apiEntries) {
  shortLines.push(`- [${entry.title}](${entry.url})`);
}
shortLines.push("");

// llms-full.txt: full concatenation in the same order.
const fullParts: string[] = [
  `# lofi documentation (v${denoJson.version})`,
  "",
  `> ${denoJson.description}`,
  "",
  `Deployed at ${siteUrl}. Package: https://jsr.io/@nzip/lofi`,
  "",
];
const allDocs: DocEntry[] = [
  ...sections.flatMap((section) => section.docs),
  ...apiEntries,
];
for (const doc of allDocs) {
  const markdown = stripFrontmatter(await Deno.readTextFile(doc.sourcePath)).trim();
  fullParts.push("---", "", `<!-- Source: ${doc.url} -->`, "", markdown, "");
}

await Deno.writeTextFile(`${OUT_DIR}/llms.txt`, shortLines.join("\n"));
await Deno.writeTextFile(`${OUT_DIR}/llms-full.txt`, fullParts.join("\n"));
const mainApiCount = apiEntries.length;

// The node-scoped pair: agents enrolling an app against a self-hosted node
// should not have to ingest the full framework corpus, and vice versa. Pages
// come from the assembled /node/docs set (tools/node_docs.ts) so contract
// pages rendered from the lofi-node checkout are included verbatim.
const NODE_DOCS_DIR = "website/node-docs-gen";
const NODE_API_DIR = "website/node-api-gen";

const nodeManifest = JSON.parse(
  await Deno.readTextFile("website/node-docs-manifest.json"),
) as Manifest;

function nodeDocUrl(id: string): string {
  return id === "README" ? `${siteUrl}/node/docs` : `${siteUrl}/node/docs/${id}`;
}

const nodeSections: Section[] = [];
for (const section of nodeManifest.sections) {
  const docs: DocEntry[] = [];
  for (const item of section.items) {
    const sourcePath = `${NODE_DOCS_DIR}/${item.id}.md`;
    let markdown: string;
    try {
      markdown = await Deno.readTextFile(sourcePath);
    } catch {
      console.error(`Missing ${sourcePath}; run \`deno task site:node\` first.`);
      Deno.exit(1);
    }
    docs.push({
      title: firstHeading(markdown) ?? item.label,
      url: nodeDocUrl(item.id),
      sourcePath,
    });
  }
  nodeSections.push({ label: section.label ?? "Documentation", docs });
}

apiEntries.length = 0;
try {
  await collectApiDir(NODE_API_DIR, `${siteUrl}/node/api`);
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
  console.error(`Missing ${NODE_API_DIR}; run \`deno task site:api:node\` first.`);
  Deno.exit(1);
}
const nodeApiEntries = [...apiEntries];
nodeApiEntries.sort((a, b) => a.position - b.position || a.url.localeCompare(b.url));

const nodeShort: string[] = [
  "# lofi-node",
  "",
  "> Self-host the sync backend for lofi apps: one daemon embedding a Jazz sync server, iroh node-to-node transport, and ticket-gated access.",
  "",
  `This file indexes the lofi-node documentation deployed at ${siteUrl}/node.`,
  `The full corpus is available at ${siteUrl}/node/llms-full.txt; the lofi framework itself is indexed at ${siteUrl}/llms.txt.`,
  "",
];
for (const section of nodeSections) {
  nodeShort.push(`## ${section.label}`, "");
  for (const doc of section.docs) nodeShort.push(`- [${doc.title}](${doc.url})`);
  nodeShort.push("");
}
nodeShort.push("## API reference", "");
for (const entry of nodeApiEntries) nodeShort.push(`- [${entry.title}](${entry.url})`);
nodeShort.push("");

const nodeFull: string[] = [
  "# lofi-node documentation",
  "",
  `> Deployed at ${siteUrl}/node. Source: https://github.com/FelineStateMachine/lofi-node`,
  "",
];
for (const doc of [...nodeSections.flatMap((section) => section.docs), ...nodeApiEntries]) {
  const markdown = stripFrontmatter(await Deno.readTextFile(doc.sourcePath)).trim();
  nodeFull.push("---", "", `<!-- Source: ${doc.url} -->`, "", markdown, "");
}

await Deno.mkdir(`${OUT_DIR}/node`, { recursive: true });
await Deno.writeTextFile(`${OUT_DIR}/node/llms.txt`, nodeShort.join("\n"));
await Deno.writeTextFile(`${OUT_DIR}/node/llms-full.txt`, nodeFull.join("\n"));

const docCount = sections.reduce((sum, section) => sum + section.docs.length, 0);
const nodeDocCount = nodeSections.reduce((sum, section) => sum + section.docs.length, 0);
console.log(
  `Generated llms.txt (${docCount} docs + ${mainApiCount} API pages), node/llms.txt ` +
    `(${nodeDocCount} docs + ${nodeApiEntries.length} API pages), and the -full pair into ${OUT_DIR}/.`,
);
