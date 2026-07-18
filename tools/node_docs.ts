/**
 * Assembles the `/node/docs` section into `website/node-docs-gen/` from two
 * sources, per `website/node-docs-manifest.json`:
 *
 * - `docs/node/*.md` in this repo — site-voice tutorials, guides, and
 *   reference pages (each names its lofi-node source material inline).
 * - Contract pages from a lofi-node checkout (`source` values prefixed
 *   `lofi-node:`) — rendered verbatim with a provenance header and relative
 *   links rewritten to the pinned checkout on GitHub, so the source of truth
 *   stays in the lofi-node repo where its CI gates it.
 *
 * The checkout location comes from `LOFI_NODE_DIR` (default `../lofi-node`);
 * the ref used in provenance links comes from `LOFI_NODE_REF` (default: the
 * checkout's current commit). Run via `deno task site:node`.
 */

const OUT_DIR = "website/node-docs-gen";

type ManifestItem = { id: string; label: string; source: string };
type ManifestSection = { label: string | null; items: ManifestItem[] };
type Manifest = { checkoutRepo: string; sections: ManifestSection[] };

const manifest = JSON.parse(
  await Deno.readTextFile("website/node-docs-manifest.json"),
) as Manifest;

const checkoutDir = Deno.env.get("LOFI_NODE_DIR") ?? "../lofi-node";

async function checkoutRef(): Promise<string> {
  const configured = Deno.env.get("LOFI_NODE_REF");
  if (configured) return configured;
  try {
    const result = await new Deno.Command("git", {
      args: ["-C", checkoutDir, "rev-parse", "HEAD"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const ref = new TextDecoder().decode(result.stdout).trim();
    if (ref) return ref;
  } catch {
    // Fall through to the branch default below.
  }
  return "main";
}

const ref = await checkoutRef();

/** Rewrites a contract page's relative links to the pinned checkout on GitHub. */
function rewriteContractLinks(markdown: string, sourceDir: string): string {
  return markdown.replace(
    /\]\((?!https?:|\/|#)([^)]+)\)/g,
    (_match, target: string) =>
      `](https://github.com/${manifest.checkoutRepo}/blob/${ref}/${sourceDir}/${target})`,
  );
}

function provenanceHeader(sourcePath: string): string {
  const url = `https://github.com/${manifest.checkoutRepo}/blob/${ref}/${sourcePath}`;
  return `:::info[Contract page]\nRendered from [\`${sourcePath}\`](${url}) in the ` +
    `\`${manifest.checkoutRepo}\` repository at the site's pinned ref — that file is the ` +
    `source of truth, gated by lofi-node's own CI.\n:::\n\n`;
}

// Docusaurus derives ids from file paths; the manifest is authoritative, so a
// page that exists on disk but not in the manifest (or vice versa) is drift.
const manifestItems = manifest.sections.flatMap((section) => section.items);

await Deno.remove(OUT_DIR, { recursive: true }).catch(() => undefined);
await Deno.mkdir(OUT_DIR, { recursive: true });

let assembled = 0;
for (const item of manifestItems) {
  let markdown: string;
  if (item.source.startsWith("lofi-node:")) {
    const relative = item.source.slice("lofi-node:".length);
    const path = `${checkoutDir}/${relative}`;
    try {
      markdown = await Deno.readTextFile(path);
    } catch {
      console.error(
        `Missing lofi-node checkout file ${path}. Set LOFI_NODE_DIR to a checkout of ` +
          `${manifest.checkoutRepo} (default ../lofi-node).`,
      );
      Deno.exit(1);
    }
    const sourceDir = relative.split("/").slice(0, -1).join("/");
    markdown = provenanceHeader(relative) + rewriteContractLinks(markdown, sourceDir);
  } else {
    try {
      markdown = await Deno.readTextFile(item.source);
    } catch {
      console.error(`Manifest names missing page source ${item.source} (id "${item.id}").`);
      Deno.exit(1);
    }
  }
  await Deno.writeTextFile(`${OUT_DIR}/${item.id}.md`, markdown);
  assembled++;
}

// Site-voice pages not named by the manifest would silently miss the sidebar
// and the llms corpus — treat them as drift.
for await (const entry of Deno.readDir("docs/node")) {
  if (!entry.isFile || !entry.name.endsWith(".md")) continue;
  const source = `docs/node/${entry.name}`;
  if (!manifestItems.some((item) => item.source === source)) {
    console.error(`docs/node/${entry.name} is not listed in website/node-docs-manifest.json.`);
    Deno.exit(1);
  }
}

console.log(
  `Assembled ${assembled} /node/docs pages into ${OUT_DIR}/ (lofi-node checkout: ${checkoutDir} @ ${
    ref.slice(0, 12)
  }).`,
);
