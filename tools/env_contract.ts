export const clientEnvironmentNames = ["JAZZ_APP_ID", "JAZZ_SERVER_URL"] as const;
export const serverEnvironmentNames = ["JAZZ_ADMIN_SECRET", "BACKEND_SECRET"] as const;
export const environmentNames = [...clientEnvironmentNames, ...serverEnvironmentNames] as const;

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
] as const;

interface EnvironmentResultBase {
  presentClientNames: string[];
  presentServerNames: string[];
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

function systemChildEnvironment(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of childEnvironmentAllowlist) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function allowedProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    childEnvironmentAllowlist.map((name) => [name, Deno.env.get(name) ?? ""]),
  );
}

export function appChildEnvironment(
  validation: Exclude<EnvironmentValidation, { ok: false }>,
  source: Readonly<Record<string, string>> = allowedProcessEnvironment(),
): Record<string, string> {
  const environment = systemChildEnvironment(source);
  if (validation.mode === "cloud-configured") {
    environment.JAZZ_APP_ID = validation.client.JAZZ_APP_ID;
    environment.JAZZ_SERVER_URL = validation.client.JAZZ_SERVER_URL;
  } else {
    environment.JAZZ_APP_ID = "";
    environment.JAZZ_SERVER_URL = "";
  }
  environment.JAZZ_ADMIN_SECRET = "";
  environment.BACKEND_SECRET = "";
  return environment;
}

export function secretScanChildEnvironment(
  loaded: Readonly<Record<string, string>>,
  source: Readonly<Record<string, string>> = allowedProcessEnvironment(),
): Record<string, string> {
  const environment = systemChildEnvironment(source);
  for (const name of serverEnvironmentNames) environment[name] = loaded[name]?.trim() ?? "";
  return environment;
}
