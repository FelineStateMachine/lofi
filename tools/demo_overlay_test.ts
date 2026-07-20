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

Deno.test("the demo uses the starter's durable notice surface", async () => {
  const incidents = await Deno.readTextFile(
    join(OVERLAY_ROOT, "src/islands/use-incidents.ts"),
  );
  const board = await Deno.readTextFile(
    join(OVERLAY_ROOT, "src/islands/IncidentBoard.tsx"),
  );
  assert(incidents.includes("s.notice<Incident>"), "incident effects must enqueue durable notices");
  assert(
    !incidents.includes("publishNotice") && !incidents.includes("useIncidentNotice"),
    "the overlay must not restore the hand-rolled in-memory notice channel",
  );
  assert(board.includes("<Notices"), "the incident board must render the durable notice queue");
});
