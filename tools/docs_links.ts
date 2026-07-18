import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const markdownFiles = [
  resolve(root, "README.md"),
  resolve(root, "CONTRIBUTING.md"),
  resolve(root, "apps/reference/README.md"),
];

async function collectMarkdown(directory: string): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory) await collectMarkdown(path);
    else if (entry.isFile && entry.name.endsWith(".md")) {
      markdownFiles.push(path);
    }
  }
}

await collectMarkdown(resolve(root, "docs"));

const broken: string[] = [];
const linkPattern = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
for (const markdown of markdownFiles) {
  const source = await Deno.readTextFile(markdown);
  for (const match of source.matchAll(linkPattern)) {
    const raw = match[1].replace(/^<|>$/g, "");
    if (raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    // Site-absolute routes (e.g. /node/docs/app-ticket) point at deployed
    // pages, some assembled at build time; the Docusaurus build validates
    // them via onBrokenLinks, not the repository tree.
    if (raw.startsWith("/")) continue;
    const target = decodeURIComponent(raw.split("#", 1)[0]);
    if (!target) continue;
    try {
      await Deno.stat(resolve(dirname(markdown), target));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      broken.push(`${markdown.slice(root.length + 1)} -> ${raw}`);
    }
  }
}

if (broken.length > 0) {
  console.error(
    `Broken local Markdown links:\n${broken.map((link) => `- ${link}`).join("\n")}`,
  );
  Deno.exit(1);
}

console.log(`Validated local links in ${markdownFiles.length} Markdown files.`);
