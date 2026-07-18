// Repository tools reuse the shipped package's dotenv parsing and loading so
// both sides of the repo read `.env` identically. Only the named-subset
// helpers below are repo-tool-specific.
import { environmentNames, parseDotenv } from "../package/tooling/environment.ts";

export { loadEnvironment, parseDotenv } from "../package/tooling/environment.ts";

export function mergeEnvironment(
  fileEnvironment: Readonly<Record<string, string>>,
  processLookup: (name: string) => string | undefined,
): Record<string, string> {
  return mergeNamedEnvironment(environmentNames, fileEnvironment, processLookup);
}

export function mergeNamedEnvironment(
  names: readonly string[],
  fileEnvironment: Readonly<Record<string, string>>,
  processLookup: (name: string) => string | undefined,
): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => [name, processLookup(name) ?? fileEnvironment[name] ?? ""]),
  );
}

export async function loadNamedEnvironment(
  names: readonly string[],
  path = ".env",
  processLookup: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Promise<Record<string, string>> {
  let fileEnvironment: Record<string, string> = {};
  try {
    fileEnvironment = parseDotenv(await Deno.readTextFile(path));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return mergeNamedEnvironment(names, fileEnvironment, processLookup);
}
