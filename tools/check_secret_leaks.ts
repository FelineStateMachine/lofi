import { serverEnvironmentNames } from "./env_contract.ts";
import { loadNamedEnvironment } from "./load_env.ts";
import { findSecretLeaks } from "./secret_scan.ts";

async function sourceFiles(): Promise<string[]> {
  const output = await new Deno.Command("git", {
    args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    stdout: "piped",
  }).output();
  if (!output.success) throw new Error("Unable to enumerate source files.");
  return new TextDecoder().decode(output.stdout).split("\0").filter(Boolean);
}

async function filesBelow(path: string): Promise<string[]> {
  try {
    const result: string[] = [];
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) result.push(...await filesBelow(child));
      else if (entry.isFile) result.push(child);
    }
    return result;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

const environment = await loadNamedEnvironment(serverEnvironmentNames);
const secretValues = serverEnvironmentNames
  .map((name) => ({ name, value: environment[name]?.trim() ?? "" }))
  .filter(({ value }) => value.length > 0);
const candidates = [...new Set([...await sourceFiles(), ...await filesBelow("dist")])];
const files: Array<{ path: string; content: Uint8Array }> = [];

for (const path of candidates) {
  try {
    files.push({ path, content: await Deno.readFile(path) });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) continue;
    throw error;
  }
}

const leaks = findSecretLeaks(files, secretValues);
if (leaks.length > 0) {
  for (const leak of leaks) console.error(`error: ${leak.name} value found in ${leak.path}`);
  Deno.exit(1);
}

console.log(
  `secret leak check passed (${candidates.length} files, ${secretValues.length} available server secrets)`,
);
