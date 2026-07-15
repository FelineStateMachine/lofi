import { collectBuildArtifactFiles } from "./artifact_files.ts";

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) throw new Error(`expected ${expected}, received ${actual}`);
}

Deno.test("nested ignored dist artifacts remain visible to the secret scanner", async () => {
  const root = await Deno.makeTempDir({ dir: ".", prefix: ".artifact-files-test-" });
  try {
    await Deno.mkdir(`${root}/apps/reference/dist/assets`, { recursive: true });
    await Deno.mkdir(`${root}/node_modules/vendor/dist`, { recursive: true });
    await Deno.writeTextFile(`${root}/apps/reference/dist/assets/client.js`, "built");
    await Deno.writeTextFile(`${root}/node_modules/vendor/dist/vendor.js`, "ignored");

    const artifacts = await collectBuildArtifactFiles(root);
    assertEquals(artifacts.length, 1);
    assertEquals(artifacts[0], `${root}/apps/reference/dist/assets/client.js`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
