import { normalizeDeploymentBase } from "./base-path.ts";

export const clientEnvironmentNames = ["JAZZ_APP_ID", "JAZZ_SERVER_URL"] as const;
export const serverEnvironmentNames = ["JAZZ_ADMIN_SECRET", "BACKEND_SECRET"] as const;
export const deploymentEnvironmentNames = ["LOFI_BASE_PATH"] as const;
export const environmentNames = [
  ...clientEnvironmentNames,
  ...serverEnvironmentNames,
  ...deploymentEnvironmentNames,
] as const;

interface EnvironmentResultBase {
  presentClientNames: string[];
  presentServerNames: string[];
  basePath: string;
  warnings: string[];
}

export type EnvironmentValidation =
  & EnvironmentResultBase
  & (
    | {
      ok: true;
      mode: "local-only";
      client: Record<string, never>;
    }
    | {
      ok: true;
      mode: "cloud-configured";
      client: { JAZZ_APP_ID: string; JAZZ_SERVER_URL: string };
    }
    | {
      ok: false;
      mode: "invalid";
      errors: string[];
    }
  );

function isPresent(env: Readonly<Record<string, string>>, name: string): boolean {
  return (env[name] ?? "").trim().length > 0;
}

export function validateEnvironment(
  env: Readonly<Record<string, string>>,
): EnvironmentValidation {
  const presentClientNames = clientEnvironmentNames.filter((name) => isPresent(env, name));
  const presentServerNames = serverEnvironmentNames.filter((name) => isPresent(env, name));
  const errors: string[] = [];
  const warnings: string[] = [];
  let basePath = "/";

  try {
    basePath = normalizeDeploymentBase(env.LOFI_BASE_PATH);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (
    presentClientNames.length > 0 && presentClientNames.length !== clientEnvironmentNames.length
  ) {
    const missing = clientEnvironmentNames.filter((name) => !isPresent(env, name));
    errors.push(
      `Cloud sync cannot start because configuration is incomplete; set ${
        missing.join(", ")
      } or remove the partial JAZZ_APP_ID/JAZZ_SERVER_URL pair to run local-only.`,
    );
  }

  if (isPresent(env, "JAZZ_SERVER_URL")) {
    try {
      const url = new URL(env.JAZZ_SERVER_URL);
      if (!new Set(["http:", "https:"]).has(url.protocol)) {
        errors.push(
          "Cloud sync cannot start because JAZZ_SERVER_URL must use http or https; correct the URL or remove the cloud configuration to run local-only.",
        );
      }
    } catch {
      errors.push(
        "Cloud sync cannot start because JAZZ_SERVER_URL is not a valid URL; correct it or remove the cloud configuration to run local-only.",
      );
    }
  }

  const base: EnvironmentResultBase = {
    presentClientNames: [...presentClientNames],
    presentServerNames: [...presentServerNames],
    basePath,
    warnings,
  };
  if (errors.length > 0) return { ...base, ok: false, mode: "invalid", errors };
  if (presentClientNames.length === 0) {
    if (presentServerNames.length > 0) {
      warnings.push(
        "Server-only credentials are present without cloud client configuration; they remain isolated and unused by the client.",
      );
    }
    return { ...base, ok: true, mode: "local-only", client: {} };
  }
  return {
    ...base,
    ok: true,
    mode: "cloud-configured",
    client: {
      JAZZ_APP_ID: env.JAZZ_APP_ID.trim(),
      JAZZ_SERVER_URL: env.JAZZ_SERVER_URL.trim(),
    },
  };
}

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

export async function loadEnvironment(
  path = ".env",
  processLookup: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Promise<Record<string, string>> {
  let fileEnvironment: Record<string, string> = {};
  try {
    fileEnvironment = parseDotenv(await Deno.readTextFile(path));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return Object.fromEntries(
    environmentNames.map((name) => [name, processLookup(name) ?? fileEnvironment[name] ?? ""]),
  );
}

const childEnvironmentAllowlist = [
  "CI",
  "DENO_DIR",
  "HOME",
  "LANG",
  "LC_ALL",
  "NIX_SSL_CERT_FILE",
  "NO_PROXY",
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  // Windows process bootstrap. Children run with a cleared environment, and
  // without these Windows cannot load system DLLs, resolve executables, or
  // locate per-user state.
  "APPDATA",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATHEXT",
  "PROGRAMDATA",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "USERPROFILE",
  "WINDIR",
] as const;

const childEnvironmentAllowedUpper = new Set<string>(
  childEnvironmentAllowlist.map((name) => name.toUpperCase()),
);

export function childEnvironment(
  validation: Exclude<EnvironmentValidation, { ok: false }>,
  source: Record<string, string> = Deno.env.toObject(),
): Record<string, string> {
  const environment: Record<string, string> = {};
  // Windows environment names are case-insensitive and arrive with arbitrary
  // casing ("Path", "SystemRoot"); match case-insensitively and preserve the
  // source casing so the child sees the variables the platform expects.
  for (const [name, value] of Object.entries(source)) {
    if (value && childEnvironmentAllowedUpper.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  if (validation.mode === "cloud-configured") {
    environment.JAZZ_APP_ID = validation.client.JAZZ_APP_ID;
    environment.JAZZ_SERVER_URL = validation.client.JAZZ_SERVER_URL;
  } else {
    environment.JAZZ_APP_ID = "";
    environment.JAZZ_SERVER_URL = "";
  }
  environment.LOFI_BASE_PATH = validation.basePath;
  environment.JAZZ_ADMIN_SECRET = "";
  environment.BACKEND_SECRET = "";
  return environment;
}
