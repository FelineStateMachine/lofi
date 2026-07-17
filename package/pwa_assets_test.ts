import { basename } from "node:path";

type ManifestIcon = { src: string; sizes: string; type: string; purpose: string };
type ManifestShortcut = {
  name: string;
  short_name?: string;
  description?: string;
  url: string;
  icons?: Array<Omit<ManifestIcon, "purpose">>;
};
type ManifestScreenshot = {
  src: string;
  sizes: string;
  type: string;
  form_factor: "narrow" | "wide";
  label: string;
};

type Manifest = {
  id: string;
  lang: string;
  dir: string;
  start_url: string;
  scope: string;
  orientation: string;
  icons: ManifestIcon[];
  screenshots: ManifestScreenshot[];
  shortcuts: ManifestShortcut[];
  [member: string]: unknown;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  assert(signature.every((byte, index) => bytes[index] === byte), "asset is not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert(new TextDecoder().decode(bytes.subarray(12, 16)) === "IHDR", "PNG has no IHDR");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

Deno.test("starter manifest declares stable identity, locale, and orientation defaults", async () => {
  const publicRoot = new URL("../apps/reference/public/", import.meta.url);
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("manifest.webmanifest", publicRoot)),
  ) as Manifest;
  assert(typeof manifest.id === "string" && manifest.id.length > 0, "manifest id is missing");
  assert(manifest.id !== manifest.start_url, "manifest id must not be derived from start_url");
  assert(manifest.lang === "en", "starter manifest language must be explicit");
  assert(manifest.dir === "ltr", "starter manifest direction must be explicit");
  assert(manifest.orientation === "any", "starter manifest must explicitly allow any orientation");

  const manifestUrl = new URL("https://example.test/field-notes/manifest.webmanifest");
  const identity = new URL(manifest.id, manifestUrl);
  const startUrl = new URL(manifest.start_url, manifestUrl);
  assert(identity.origin === startUrl.origin, "manifest id must remain same-origin");

  for (
    const member of [
      "capture_links",
      "display_override",
      "edge_side_panel",
      "file_handlers",
      "handle_links",
      "launch_handler",
      "protocol_handlers",
      "scope_extensions",
      "share_target",
      "tab_strip",
    ]
  ) {
    assert(!(member in manifest), `experimental member ${member} must be opt-in`);
  }
  assert(!("iarc_rating_id" in manifest), "starter manifest must not claim an IARC rating");
  assert(!("categories" in manifest), "product categories must be chosen by the app author");
});

Deno.test("starter manifest covers regular, maskable, monochrome, and Apple icons", async () => {
  const publicRoot = new URL("../apps/reference/public/", import.meta.url);
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("manifest.webmanifest", publicRoot)),
  ) as Manifest;
  const expected = new Map([
    ["icon-192.png", { size: 192, purpose: "any" }],
    ["icon-512.png", { size: 512, purpose: "any" }],
    ["icon-maskable-512.png", { size: 512, purpose: "maskable" }],
  ]);
  const rasterIcons = manifest.icons.filter((icon) => icon.type === "image/png");
  for (const icon of rasterIcons) {
    const file = basename(icon.src);
    const contract = expected.get(file);
    assert(contract, `manifest references unexpected icon ${file}`);
    assert(icon.type === "image/png", `${file} must declare image/png`);
    assert(icon.purpose === contract.purpose, `${file} has the wrong purpose`);
    assert(
      icon.sizes === `${contract.size}x${contract.size}`,
      `${file} has the wrong declared size`,
    );
    const dimensions = pngDimensions(await Deno.readFile(new URL(file, publicRoot)));
    assert(
      dimensions.width === contract.size && dimensions.height === contract.size,
      `${file} is ${dimensions.width}x${dimensions.height}`,
    );
  }
  assert(rasterIcons.length === expected.size, "starter raster icon roles are incomplete");

  const monochrome = manifest.icons.find((icon) => icon.purpose === "monochrome");
  assert(monochrome, "manifest has no monochrome icon");
  assert(monochrome.type === "image/svg+xml", "monochrome icon must be a vector silhouette");
  assert(monochrome.sizes === "any", "vector monochrome icon must declare any size");
  const monochromeSource = await Deno.readTextFile(new URL(monochrome.src, publicRoot));
  assert(monochromeSource.includes("<svg"), "monochrome icon is not SVG");
  assert(
    !monochromeSource.includes("<rect"),
    "monochrome icon must keep its background transparent",
  );

  const apple = pngDimensions(await Deno.readFile(new URL("apple-touch-icon.png", publicRoot)));
  assert(apple.width === 180 && apple.height === 180, "apple-touch-icon.png must be 180x180");
  const shell = await Deno.readTextFile(
    new URL("../apps/reference/src/layouts/Shell.astro", import.meta.url),
  );
  assert(
    shell.includes("const deploymentBase = import.meta.env.BASE_URL") &&
      shell.includes('publicAsset("apple-touch-icon.png")') &&
      shell.includes('publicAsset("manifest.webmanifest")'),
    "install assets are not linked through the deployment base",
  );
});

Deno.test("starter shortcut and its icons stay inside the application scope", async () => {
  const publicRoot = new URL("../apps/reference/public/", import.meta.url);
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("manifest.webmanifest", publicRoot)),
  ) as Manifest;
  assert(manifest.shortcuts.length === 1, "starter must carry one clearly replaceable shortcut");

  const manifestUrl = new URL("https://example.test/field-notes/manifest.webmanifest");
  const scope = new URL(manifest.scope, manifestUrl);
  const shortcut = manifest.shortcuts[0];
  const shortcutUrl = new URL(shortcut.url, manifestUrl);
  assert(shortcutUrl.href.startsWith(scope.href), "starter shortcut escapes manifest scope");
  assert(shortcut.icons?.length, "starter shortcut has no icon");
  for (const icon of shortcut.icons) {
    const iconUrl = new URL(icon.src, manifestUrl);
    assert(iconUrl.href.startsWith(scope.href), "starter shortcut icon escapes manifest scope");
    assert(
      manifest.icons.some((candidate) => candidate.src === icon.src),
      "starter shortcut icon is not part of the install icon set",
    );
  }

  const taskIsland = await Deno.readTextFile(
    new URL("../apps/reference/src/islands/TaskList.tsx", import.meta.url),
  );
  assert(taskIsland.includes('id="tasks"'), "starter shortcut has no matching task anchor");
});

Deno.test("starter install screenshots are labeled narrow and wide captures", async () => {
  const publicRoot = new URL("../apps/reference/public/", import.meta.url);
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("manifest.webmanifest", publicRoot)),
  ) as Manifest;
  const expected = new Map([
    ["narrow", { file: "screenshot-narrow.png", width: 540, height: 720 }],
    ["wide", { file: "screenshot-wide.png", width: 1280, height: 720 }],
  ]);
  assert(manifest.screenshots.length === expected.size, "starter screenshot set must stay small");
  for (const screenshot of manifest.screenshots) {
    const contract = expected.get(screenshot.form_factor);
    assert(contract, `unexpected screenshot form factor ${screenshot.form_factor}`);
    assert(basename(screenshot.src) === contract.file, `${screenshot.form_factor} file drifted`);
    assert(screenshot.type === "image/png", `${contract.file} must declare image/png`);
    assert(screenshot.label.trim().length > 0, `${contract.file} needs an accessible label`);
    assert(
      screenshot.sizes === `${contract.width}x${contract.height}`,
      `${contract.file} has the wrong declared size`,
    );
    const dimensions = pngDimensions(await Deno.readFile(new URL(contract.file, publicRoot)));
    assert(
      dimensions.width === contract.width && dimensions.height === contract.height,
      `${contract.file} is ${dimensions.width}x${dimensions.height}`,
    );
  }
});
