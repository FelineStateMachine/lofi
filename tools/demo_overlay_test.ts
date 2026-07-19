import { STARTER_FILES } from "../package/starter_template.ts";
import { listOverlayFiles, NEW_FILES, OVERLAY_ROOT, VERSION_PLACEHOLDER } from "./demo_overlay.ts";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("every overlay file shadows a starter file or is allowlisted", async () => {
  const overlayFiles = await listOverlayFiles();
  assert(overlayFiles.length > 0, "the demo overlay must not be empty");
  const starter = new Set(STARTER_FILES);
  const orphans = overlayFiles.filter(
    (path) => !starter.has(path) && !NEW_FILES.includes(path),
  );
  assert(
    orphans.length === 0,
    `overlay files without a starter counterpart (rename them with the starter ` +
      `or add them to NEW_FILES): ${orphans.join(", ")}`,
  );
});

Deno.test("allowlisted new files exist in the overlay", async () => {
  const overlayFiles = new Set(await listOverlayFiles());
  const missing = NEW_FILES.filter((path) => !overlayFiles.has(path));
  assert(missing.length === 0, `NEW_FILES entries missing from the overlay: ${missing.join(", ")}`);
});

Deno.test("the demo landing page stamps the released version", async () => {
  const index = await Deno.readTextFile(join(OVERLAY_ROOT, "src/pages/index.astro"));
  assert(
    index.includes(VERSION_PLACEHOLDER),
    `src/pages/index.astro must carry ${VERSION_PLACEHOLDER} so visitors can see ` +
      `which release produced the demo`,
  );
});
