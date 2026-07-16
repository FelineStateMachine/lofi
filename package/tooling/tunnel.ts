import { join } from "node:path";

export type DenoTunnelOrigin = {
  host: string;
  url: string;
};

type DenoConfig = {
  deploy?: {
    app?: unknown;
    org?: unknown;
  };
};

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function deployLabel(value: unknown, name: "app" | "org"): string {
  if (typeof value !== "string" || !dnsLabel.test(value)) {
    throw new Error(
      `Deno Deploy ${name} is not a safe DNS label; rerun \`deno task --tunnel dev\` and select the application again`,
    );
  }
  return value;
}

export function denoTunnelOriginFromConfig(config: DenoConfig): DenoTunnelOrigin | null {
  if (!config.deploy) return null;

  const app = deployLabel(config.deploy.app, "app");
  const org = deployLabel(config.deploy.org, "org");
  const host = `${app}--local.${org}.deno.net`;
  if (host.length > 253 || host.split(".").some((label) => label.length > 63)) {
    throw new Error(
      "Deno Deploy app and organization produce an invalid tunnel hostname; select shorter names",
    );
  }
  return { host, url: `https://${host}/` };
}

export async function denoTunnelOrigin(root = Deno.cwd()): Promise<DenoTunnelOrigin | null> {
  const source = await Deno.readTextFile(join(root, "deno.json"));
  return denoTunnelOriginFromConfig(JSON.parse(source) as DenoConfig);
}
