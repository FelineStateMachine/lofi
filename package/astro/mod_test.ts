import { prepareLofiAstroConfig } from "./mod.ts";

Deno.test("prepareLofiAstroConfig materializes package-owned vendor integration", async () => {
  const root = await Deno.makeTempDir({ dir: ".", prefix: ".lofi-astro-test-" });
  try {
    const path = await prepareLofiAstroConfig({ root });
    const source = await Deno.readTextFile(path);
    if (!path.endsWith("/.lofi/astro.config.ts")) throw new Error(`unexpected path: ${path}`);
    for (
      const expected of [
        "@astrojs/preact",
        "jazz-tools/dev/vite",
        "JAZZ_APP_ID",
        ".lofi/package/runtime/mod.ts",
        "^jsr:@nzip\\/lofi@[^/]+",
        "^npm:preact@[^/]+",
        "^npm:jazz-tools@[^/]+",
        'replacement: "preact/hooks"',
        'replacement: "jazz-tools/passphrase"',
      ]
    ) {
      if (!source.includes(expected)) throw new Error(`generated config omitted ${expected}`);
    }
    await Deno.stat(`${root}/.lofi/package/preact/DeviceStatus.tsx`);
    await Deno.stat(`${root}/.lofi/package/runtime/passkey-recovery.ts`);
    await Deno.stat(`${root}/.lofi/package/access/mod.ts`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
