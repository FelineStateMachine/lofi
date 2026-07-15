import { environmentNames } from "./env_contract.ts";

export function parseDotenv(source: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const originalLine of source.split(/\r?\n/)) {
    let line = originalLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    if (!environmentNames.includes(name as (typeof environmentNames)[number])) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    parsed[name] = value;
  }
  return parsed;
}

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

export async function loadEnvironment(
  path = ".env",
  processLookup: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Promise<Record<string, string>> {
  return await loadNamedEnvironment(environmentNames, path, processLookup);
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
