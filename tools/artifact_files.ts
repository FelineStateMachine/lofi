const ignoredDirectoryNames = new Set([
  ".git",
  ".playwright-cli",
  ".vite",
  "node_modules",
]);

async function filesBelow(path: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory) files.push(...await filesBelow(child));
    else if (entry.isFile) files.push(child);
  }
  return files;
}

export async function collectBuildArtifactFiles(root = "."): Promise<string[]> {
  const artifacts: string[] = [];

  async function visit(path: string) {
    for await (const entry of Deno.readDir(path)) {
      if (!entry.isDirectory || ignoredDirectoryNames.has(entry.name)) continue;
      const child = path === "." ? entry.name : `${path}/${entry.name}`;
      if (entry.name === "dist") artifacts.push(...await filesBelow(child));
      else await visit(child);
    }
  }

  try {
    await visit(root);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  return artifacts;
}
