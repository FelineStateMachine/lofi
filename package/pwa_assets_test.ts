import { basename } from "node:path";

type ManifestIcon = { src: string; sizes: string; type: string; purpose: string };

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

Deno.test("starter manifest references install-grade raster icons with exact dimensions", async () => {
  const publicRoot = new URL("../apps/reference/public/", import.meta.url);
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("manifest.webmanifest", publicRoot)),
  ) as {
    icons: ManifestIcon[];
  };
  const expected = new Map([
    ["icon-192.png", { size: 192, purpose: "any" }],
    ["icon-512.png", { size: 512, purpose: "any" }],
    ["icon-maskable-512.png", { size: 512, purpose: "maskable" }],
  ]);
  assert(manifest.icons.length === expected.size, "manifest icon set changed unexpectedly");
  for (const icon of manifest.icons) {
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
