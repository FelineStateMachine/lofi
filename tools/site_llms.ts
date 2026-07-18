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
    const url = stem === "index" ? `${siteUrl}/api` : `${urlPrefix}/${stem}`;
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

const docCount = sections.reduce((sum, section) => sum + section.docs.length, 0);
console.log(
  `Generated llms.txt (${docCount} docs + ${apiEntries.length} API pages) and llms-full.txt into ${OUT_DIR}/.`,
);
