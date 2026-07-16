#!/usr/bin/env -S deno run -A

import { extname, join, normalize } from "node:path";

const portFlag = Deno.args.findIndex((argument) => argument === "--port");
const port = portFlag >= 0 ? Number(Deno.args[portFlag + 1]) : 4321;
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("error: preview --port must be an integer from 1 to 65535");
  Deno.exit(2);
}

let identity: { lofiVersion?: string; sourceHash?: string };
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

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

console.log(
  `lofi preview: http://127.0.0.1:${port}/ (build ${identity.sourceHash}, @nzip/lofi ${identity.lofiVersion})`,
);
Deno.serve({ hostname: "127.0.0.1", port }, async (request) => {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  const relative = normalize(pathname).replace(/^[/\\]+/, "");
  if (relative.startsWith("..")) return new Response("Not found", { status: 404 });
  const path = join("dist", relative);
  try {
    const body = await Deno.readFile(path);
    return new Response(request.method === "HEAD" ? null : body, {
      headers: { "content-type": contentTypes[extname(path)] ?? "application/octet-stream" },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return new Response("Not found", { status: 404 });
    throw error;
  }
});
