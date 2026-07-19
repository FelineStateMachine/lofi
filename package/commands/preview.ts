#!/usr/bin/env -S deno run -A

/**
 * The `deno task preview` command: serves the built `dist/` output locally over
 * HTTP for previewing the production PWA.
 *
 * @module
 */

import { join, normalize } from "node:path";
import { normalizeDeploymentBase, pathWithinDeploymentBase } from "../tooling/base-path.ts";
import { productionContentType } from "../tooling/pwa-validation.ts";

const portFlag = Deno.args.findIndex((argument) => argument === "--port");
const port = portFlag >= 0 ? Number(Deno.args[portFlag + 1]) : 4321;
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("error: preview --port must be an integer from 1 to 65535");
  Deno.exit(2);
}

let identity: { lofiVersion?: string; sourceHash?: string; basePath?: string; csp?: string };
try {
  identity = JSON.parse(await Deno.readTextFile("dist/lofi-build.json"));
} catch {
  console.error("error: production build is missing or stale; run `deno task build` first");
  Deno.exit(1);
}
if (!identity.sourceHash) {
  console.error("error: production build identity is invalid; run `deno task build` again");
  Deno.exit(1);
}
const basePath = normalizeDeploymentBase(identity.basePath);

console.log(
  `lofi preview: http://127.0.0.1:${port}${basePath} (build ${identity.sourceHash}, @nzip/lofi ${identity.lofiVersion})`,
);
Deno.serve({ hostname: "127.0.0.1", port }, async (request) => {
  const url = new URL(request.url);
  if (basePath !== "/" && url.pathname === basePath.slice(0, -1)) {
    return Response.redirect(new URL(basePath, url.origin), 308);
  }
  const scopedPath = pathWithinDeploymentBase(url.pathname, basePath);
  if (scopedPath === null) return new Response("Not found", { status: 404 });
  let pathname = decodeURIComponent(scopedPath);
  if (pathname === "" || pathname.endsWith("/")) pathname += "index.html";
  const relative = normalize(pathname).replace(/^[/\\]+/, "");
  if (relative.startsWith("..")) return new Response("Not found", { status: 404 });
  const path = join("dist", relative);
  try {
    const body = await Deno.readFile(path);
    const contentType = productionContentType(path);
    const headers: Record<string, string> = { "content-type": contentType };
    // The built pages enforce the policy via meta; preview also sends the
    // real header so the header path — including frame-ancestors and the
    // service worker's own execution — is exercised before deployment.
    if (identity.csp && (contentType.startsWith("text/html") || relative === "sw.js")) {
      headers["content-security-policy"] = `${identity.csp}; frame-ancestors 'none'`;
    }
    return new Response(request.method === "HEAD" ? null : body, { headers });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return new Response("Not found", { status: 404 });
    throw error;
  }
});
