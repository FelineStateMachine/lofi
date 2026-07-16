import { LOFI_VERSION } from "../version.ts";
import { type EnvironmentValidation, loadEnvironment, validateEnvironment } from "./environment.ts";
import { type ProjectCheck, projectChecks } from "./project.ts";

export type Diagnostic = {
  name: string;
  status: "ok" | "pending" | "blocker";
  detail: string;
  remediation?: string;
};

export type DoctorReport = {
  version: string;
  validation: EnvironmentValidation;
  diagnostics: Diagnostic[];
  blocked: boolean;
};

function denoSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 2 || (major === 2 && minor >= 9);
}

function projectDiagnostics(checks: readonly ProjectCheck[]): Diagnostic[] {
  return checks.map((check) => ({
    name: check.name,
    status: check.status,
    detail: check.detail,
    remediation: check.remediation,
  }));
}

export async function doctorReport(
  options: {
    root?: string;
    environment?: Readonly<Record<string, string>>;
    denoVersion?: string;
  } = {},
): Promise<DoctorReport> {
  const root = options.root ?? Deno.cwd();
  const environment = options.environment ?? await loadEnvironment(`${root}/.env`);
  const validation = validateEnvironment(environment);
  const denoVersion = options.denoVersion ?? Deno.version.deno;
  const diagnostics: Diagnostic[] = [
    {
      name: "Package",
      status: "ok",
      detail: `@nzip/lofi ${LOFI_VERSION}`,
    },
    denoSupported(denoVersion) ? { name: "Deno", status: "ok", detail: denoVersion } : {
      name: "Deno",
      status: "blocker",
      detail: `${denoVersion} is older than the supported 2.9 line`,
      remediation: "upgrade Deno, then rerun `deno task doctor`",
    },
    ...projectDiagnostics(await projectChecks(root)),
  ];

  if (validation.ok) {
    diagnostics.push({
      name: "Environment",
      status: "ok",
      detail: validation.mode,
    });
  } else {
    for (const error of validation.errors) {
      diagnostics.push({
        name: "Environment",
        status: "blocker",
        detail: error,
        remediation: "edit `.env` once, then rerun `deno task doctor`",
      });
    }
  }
  diagnostics.push(
    {
      name: "Storage",
      status: "pending",
      detail: "OPFS durable driver requested; browser capability check runs at application boot",
      remediation: "open the printed local or stable HTTPS URL in a supported browser",
    },
    {
      name: "Persistence",
      status: "pending",
      detail: "browser eviction protection has not been queried",
      remediation: "use the in-app device gate to request and verify persistence",
    },
    {
      name: "Identity",
      status: "ok",
      detail: validation.mode === "cloud-configured"
        ? "local-first account; users can back up and recover via a recovery phrase"
        : "local-first account; local-only until a managed Jazz app is configured",
    },
    {
      name: "Sync",
      status: validation.mode === "cloud-configured" ? "ok" : "pending",
      detail: validation.mode === "cloud-configured"
        ? "managed adapter configured; users elect to back up and sync per account"
        : "local-only; no transport convergence claim",
    },
    {
      name: "PWA",
      status: "pending",
      detail: "development service worker disabled; production activation checked in browser",
    },
    {
      name: "Device URL",
      status: "pending",
      detail: "not configured; stable HTTPS device preview graduates in M3",
    },
  );

  return {
    version: LOFI_VERSION,
    validation,
    diagnostics,
    blocked: diagnostics.some((diagnostic) => diagnostic.status === "blocker"),
  };
}

export function printDoctorReport(report: DoctorReport): void {
  console.log(`lofi doctor ${report.version}`);
  const width = Math.max(...report.diagnostics.map((diagnostic) => diagnostic.name.length));
  for (const diagnostic of report.diagnostics) {
    console.log(
      `${diagnostic.name.padEnd(width)}  ${diagnostic.status.padEnd(7)}  ${diagnostic.detail}`,
    );
    if (diagnostic.remediation) {
      console.log(`${"".padEnd(width)}  action   ${diagnostic.remediation}`);
    }
  }
  for (const warning of report.validation.warnings) console.warn(`warning: ${warning}`);
}
