/**
 * Assembles the `/node/docs` section into `website/node-docs-gen/` from a
 * lofi-node checkout, per `website/node-docs-manifest.json` (every `source`
 * is `lofi-node:`-prefixed). The docs live with the node so its CI gates
 * them; the site pins the checkout for reproducible builds.
 *
 * - Site-voice pages (`docs/site/*.md` there) render as-is: links between
 *   manifest pages stay site-internal, links to anything else in the
 *   checkout are rewritten to the pinned ref on GitHub.
 * - Contract pages (`"contract": true`, e.g. the app-ticket format) render
 *   verbatim with a provenance header and every relative link rewritten to
 *   GitHub — the file itself is the normative artifact.
 *
 * The checkout location comes from `LOFI_NODE_DIR` (default `../lofi-node`);
 * the ref used in provenance links comes from `LOFI_NODE_REF` (default: the
 * checkout's current commit). Run via `deno task site:node`.
 */

const OUT_DIR = "website/node-docs-gen";

type ManifestItem = { id: string; label: string; source: string; contract?: boolean };
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

// Resolves a relative link target against its page's checkout directory,
// dropping any fragment; used to decide whether the target is a sibling
// manifest page (stays site-internal) or checkout material (goes to GitHub).
function resolveCheckoutPath(sourceDir: string, target: string): string {
  const withoutFragment = target.split("#")[0];
  const segments = `${sourceDir}/${withoutFragment}`.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

/**
 * Rewrites a page's relative links to the pinned checkout on GitHub. For
 * site-voice pages, links whose target is another manifest page are left
 * alone — Docusaurus resolves them inside the generated section, keeping
 * navigation on-site.
 */
function rewriteCheckoutLinks(
  markdown: string,
  sourceDir: string,
  siteInternalTargets: ReadonlySet<string>,
): string {
  return markdown.replace(
    /\]\((?!https?:|\/|#)([^)]+)\)/g,
    (match: string, target: string) =>
      siteInternalTargets.has(resolveCheckoutPath(sourceDir, target))
        ? match
        : `](https://github.com/${manifest.checkoutRepo}/blob/${ref}/${sourceDir}/${target})`,
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

// Non-contract pages whose sibling links must survive as site navigation.
const siteInternalTargets = new Set(
  manifestItems
    .filter((item) => !item.contract)
    .map((item) => item.source.slice("lofi-node:".length)),
);

let assembled = 0;
for (const item of manifestItems) {
  if (!item.source.startsWith("lofi-node:")) {
    console.error(`Manifest source ${item.source} (id "${item.id}") is not lofi-node:-prefixed.`);
    Deno.exit(1);
  }
  const relative = item.source.slice("lofi-node:".length);
  const path = `${checkoutDir}/${relative}`;
  let markdown: string;
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
  markdown = item.contract
    ? provenanceHeader(relative) + rewriteCheckoutLinks(markdown, sourceDir, new Set())
    : rewriteCheckoutLinks(markdown, sourceDir, siteInternalTargets);
  await Deno.writeTextFile(`${OUT_DIR}/${item.id}.md`, markdown);
  assembled++;
}

// Site-voice pages in the checkout but not in the manifest would silently
// miss the sidebar and the llms corpus — treat them as drift.
for await (const entry of Deno.readDir(`${checkoutDir}/docs/site`)) {
  if (!entry.isFile || !entry.name.endsWith(".md")) continue;
  const source = `lofi-node:docs/site/${entry.name}`;
  if (!manifestItems.some((item) => item.source === source)) {
    console.error(
      `checkout docs/site/${entry.name} is not listed in website/node-docs-manifest.json.`,
    );
    Deno.exit(1);
  }
}

console.log(
  `Assembled ${assembled} /node/docs pages into ${OUT_DIR}/ (lofi-node checkout: ${checkoutDir} @ ${
    ref.slice(0, 12)
  }).`,
);
