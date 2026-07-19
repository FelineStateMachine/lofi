import { join } from "node:path";
import { createProject } from "../create_core.ts";
import {
  expectedPrecacheUrls,
  productionContentType,
  productionPwaIssues,
  screenshotAssetPaths,
  sourcePwaIssues,
} from "./pwa-validation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function makeProject(): Promise<{ root: string; project: string }> {
  const root = await Deno.makeTempDir({ dir: ".", prefix: ".lofi-pwa-validation-test-" });
  const result = await createProject({ cwd: root, name: "app" });
  return { root, project: result.destination };
}

async function readManifest(project: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(join(project, "public", "manifest.webmanifest")));
}

async function writeManifest(project: string, manifest: Record<string, unknown>): Promise<void> {
  await Deno.writeTextFile(
    join(project, "public", "manifest.webmanifest"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function hasIssue(issues: readonly { detail: string }[], text: string): boolean {
  return issues.some((entry) => entry.detail.includes(text));
}

Deno.test("source PWA validation accepts the generated root and subpath contracts", async () => {
  const { root, project } = await makeProject();
  try {
    assert((await sourcePwaIssues(project)).length === 0, "root manifest was rejected");
    assert(
      (await sourcePwaIssues(project, "/field-notes/")).length === 0,
      "subpath manifest was rejected",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation names malformed identity and scope failures", async () => {
  const { root, project } = await makeProject();
  const path = join(project, "public", "manifest.webmanifest");
  try {
    await Deno.writeTextFile(path, "{\n");
    const malformed = await sourcePwaIssues(project);
    assert(
      hasIssue(malformed, "public/manifest.webmanifest: malformed JSON"),
      "JSON failure was vague",
    );

    const manifest = await readManifest(join(import.meta.dirname!, "../../apps/reference"));
    delete manifest.id;
    manifest.start_url = "../outside";
    manifest.scope = "./";
    await writeManifest(project, manifest);
    const invalid = await sourcePwaIssues(project, "/field-notes/");
    assert(hasIssue(invalid, "id must be a non-empty string"), "missing id was accepted");
    assert(hasIssue(invalid, "start_url must stay inside scope"), "escaped start_url was accepted");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("build preflight rejects a malformed manifest before Astro runs", async () => {
  const root = await Deno.makeTempDir({ dir: ".", prefix: ".lofi-pwa-build-test-" });
  try {
    const result = await createProject({
      cwd: root,
      name: "app",
      packagePrefix: new URL("../", import.meta.url).href,
    });
    await Deno.writeTextFile(join(result.destination, "public", "manifest.webmanifest"), "{\n");
    const command = await new Deno.Command(Deno.execPath(), {
      args: ["task", "build"],
      cwd: result.destination,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = `${new TextDecoder().decode(command.stdout)}\n${
      new TextDecoder().decode(command.stderr)
    }`;
    assert(!command.success, "build accepted a malformed manifest");
    assert(
      output.includes("public/manifest.webmanifest: malformed JSON"),
      "build failure was vague",
    );
    assert(
      !output.includes("Building static entrypoints"),
      "build reached Astro after failed preflight",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation detects missing and incorrectly sized icons", async () => {
  const { root, project } = await makeProject();
  try {
    await Deno.copyFile(
      join(project, "public", "apple-touch-icon.png"),
      join(project, "public", "icon-192.png"),
    );
    await Deno.remove(join(project, "public", "icon-monochrome.svg"));
    const issues = await sourcePwaIssues(project);
    assert(hasIssue(issues, "icon-192.png (180x180)"), "incorrect raster dimensions were accepted");
    assert(hasIssue(issues, "missing asset icon-monochrome.svg"), "missing icon was accepted");
    assert(hasIssue(issues, "scalable monochrome image"), "missing icon role was not reported");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation checks optional shortcuts and screenshots", async () => {
  const { root, project } = await makeProject();
  try {
    const manifest = await readManifest(project);
    manifest.shortcuts = [{ name: "Escape", url: "../outside" }];
    manifest.screenshots = [{
      src: "./missing-shot.png",
      sizes: "1200x800",
      type: "image/png",
    }];
    await writeManifest(project, manifest);
    const issues = await sourcePwaIssues(project, "/field-notes/");
    assert(hasIssue(issues, "shortcuts[0].url must stay inside"), "escaped shortcut was accepted");
    assert(hasIssue(issues, "missing asset missing-shot.png"), "missing screenshot was accepted");
    assert(hasIssue(issues, "label must describe"), "unlabeled screenshot was accepted");
    assert(hasIssue(issues, "form_factor must be narrow or wide"), "missing form factor passed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation checks an opt-in text share target", async () => {
  const { root, project } = await makeProject();
  try {
    const manifest = await readManifest(project);
    manifest.share_target = {
      action: "../outside?existing=1",
      method: "POST",
      enctype: "multipart/form-data",
      params: { title: "shared", text: "shared", files: { name: "files" }, extra: "value" },
    };
    await writeManifest(project, manifest);
    const issues = await sourcePwaIssues(project, "/field-notes/");
    assert(hasIssue(issues, "action must stay inside"), "escaped share action was accepted");
    assert(hasIssue(issues, "must not contain a query"), "share action query was accepted");
    assert(hasIssue(issues, "method must be GET"), "POST share action was accepted");
    assert(hasIssue(issues, "enctype must be application"), "multipart share action was accepted");
    assert(hasIssue(issues, "params.files requires"), "file share params were accepted");
    assert(hasIssue(issues, "unsupported members"), "unknown share param was accepted");
    assert(hasIssue(issues, "params names must be unique"), "duplicate param names were accepted");

    manifest.share_target = {
      action: "./share/",
      method: "GET",
      enctype: "application/x-www-form-urlencoded",
      params: { title: "title", text: "text", url: "url" },
    };
    await writeManifest(project, manifest);
    const valid = await sourcePwaIssues(project, "/field-notes/");
    assert(valid.length === 0, `valid share target was rejected: ${JSON.stringify(valid)}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation checks an opt-in launch handler", async () => {
  const { root, project } = await makeProject();
  try {
    const manifest = await readManifest(project);
    manifest.launch_handler = {
      client_mode: ["focus-existing", "focus-existing", "invented"],
      navigation: "unsafe",
    };
    await writeManifest(project, manifest);
    const issues = await sourcePwaIssues(project);
    assert(hasIssue(issues, "contains unsupported members"), "unknown launch member was accepted");
    assert(hasIssue(issues, "supports auto"), "unknown client mode was accepted");
    assert(hasIssue(issues, "must not repeat modes"), "duplicate client mode was accepted");

    manifest.launch_handler = { client_mode: ["focus-existing", "auto"] };
    await writeManifest(project, manifest);
    const valid = await sourcePwaIssues(project);
    assert(valid.length === 0, `valid launch handler was rejected: ${JSON.stringify(valid)}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation checks window controls overlay with standalone fallback", async () => {
  const { root, project } = await makeProject();
  try {
    const manifest = await readManifest(project);
    manifest.display_override = ["tabbed", "window-controls-overlay", "window-controls-overlay"];
    await writeManifest(project, manifest);
    const issues = await sourcePwaIssues(project);
    assert(
      hasIssue(issues, "without a tested lofi recipe"),
      "tabbed mode was presented as shipped",
    );
    assert(hasIssue(issues, "must not repeat modes"), "duplicate display override passed");

    manifest.display_override = ["window-controls-overlay"];
    await writeManifest(project, manifest);
    const valid = await sourcePwaIssues(project);
    assert(valid.length === 0, `valid window controls override failed: ${JSON.stringify(valid)}`);
    assert(manifest.display === "standalone", "fixture lost its standalone fallback");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation checks opt-in file handlers", async () => {
  const { root, project } = await makeProject();
  try {
    const manifest = await readManifest(project);
    manifest.file_handlers = [{
      action: "../outside?unsafe=1",
      accept: {
        "application/*": ["json"],
        "application/json": [".json", ".json"],
      },
      icons: [{
        src: "./missing-file-icon.png",
        sizes: "64x64",
        type: "image/png",
      }],
      extra: true,
    }];
    await writeManifest(project, manifest);
    const issues = await sourcePwaIssues(project, "/field-notes/");
    assert(hasIssue(issues, "action must stay inside"), "escaped file action was accepted");
    assert(hasIssue(issues, "must not contain a query"), "file action query was accepted");
    assert(hasIssue(issues, "explicit lowercase MIME"), "wildcard MIME type was accepted");
    assert(hasIssue(issues, "lowercase dot-extension"), "bare extension was accepted");
    assert(hasIssue(issues, "must not repeat"), "duplicate extension was accepted");
    assert(hasIssue(issues, "missing asset missing-file-icon.png"), "missing file icon passed");
    assert(hasIssue(issues, "contains unsupported members"), "unknown file member was accepted");

    manifest.file_handlers = [{
      action: "./import/",
      accept: { "application/json": [".json"] },
    }];
    await writeManifest(project, manifest);
    const valid = await sourcePwaIssues(project, "/field-notes/");
    assert(valid.length === 0, `valid file handler was rejected: ${JSON.stringify(valid)}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation checks opt-in protocol handlers", async () => {
  const { root, project } = await makeProject();
  try {
    const manifest = await readManifest(project);
    manifest.protocol_handlers = [{
      protocol: "mailto",
      url: "../outside/%s?again=%s#fragment",
      extra: true,
    }, {
      protocol: "web+lofi",
      url: "./open/?url=prefix-%s",
    }, {
      protocol: "web+lofi",
      url: "./open/?url=%s",
    }];
    await writeManifest(project, manifest);
    const issues = await sourcePwaIssues(project, "/field-notes/");
    assert(hasIssue(issues, "custom lowercase web+"), "privileged protocol was accepted");
    assert(hasIssue(issues, "exactly one %s"), "duplicate placeholder was accepted");
    assert(hasIssue(issues, "complete value"), "prefixed placeholder was accepted");
    assert(hasIssue(issues, "must not repeat"), "duplicate protocol was accepted");
    assert(hasIssue(issues, "contains unsupported members"), "unknown protocol member passed");

    manifest.protocol_handlers = [{ protocol: "web+lofi", url: "./open/?url=%s" }];
    await writeManifest(project, manifest);
    const valid = await sourcePwaIssues(project, "/field-notes/");
    assert(valid.length === 0, `valid protocol handler was rejected: ${JSON.stringify(valid)}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation checks opt-in related applications without preferring them", async () => {
  const { root, project } = await makeProject();
  try {
    const manifest = await readManifest(project);
    manifest.prefer_related_applications = true;
    manifest.related_applications = [{
      platform: "invented",
      url: "http://user:secret@store.invalid/app",
      extra: true,
    }];
    await writeManifest(project, manifest);
    const issues = await sourcePwaIssues(project);
    assert(hasIssue(issues, "preserve PWA installability"), "native preference was accepted");
    assert(hasIssue(issues, "platform is not supported"), "invented platform was accepted");
    assert(hasIssue(issues, "credential-free HTTPS"), "unsafe related URL was accepted");
    assert(hasIssue(issues, "contains unsupported members"), "unknown related member passed");

    manifest.prefer_related_applications = false;
    manifest.related_applications = [{
      platform: "play",
      id: "com.example.companion",
      url: "https://play.google.com/store/apps/details?id=com.example.companion",
    }];
    await writeManifest(project, manifest);
    const valid = await sourcePwaIssues(project);
    assert(valid.length === 0, `valid related app was rejected: ${JSON.stringify(valid)}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation checks opt-in scope extensions", async () => {
  const { root, project } = await makeProject();
  try {
    const manifest = await readManifest(project);
    manifest.scope_extensions = [
      {
        type: "invented",
        origin: "http://user:secret@help.example.com/path?unsafe=1",
        authorization: true,
      },
      { type: "origin", origin: "https://help.example.com" },
      {
        type: "origin",
        origin: "https://help.example.com",
      },
    ];
    await writeManifest(project, manifest);
    const issues = await sourcePwaIssues(project);
    assert(hasIssue(issues, "type must be origin"), "invented extension type was accepted");
    assert(hasIssue(issues, "exact credential-free HTTPS origin"), "unsafe origin was accepted");
    assert(hasIssue(issues, "contains unsupported members"), "unknown extension member passed");
    assert(hasIssue(issues, "origin must not repeat"), "duplicate origin was accepted");

    manifest.scope_extensions = [{ type: "origin", origin: "https://help.example.com" }];
    await writeManifest(project, manifest);
    const valid = await sourcePwaIssues(project);
    assert(valid.length === 0, `valid scope extension was rejected: ${JSON.stringify(valid)}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("source PWA validation permits replacement branding and optional members", async () => {
  const { root, project } = await makeProject();
  try {
    for (
      const [before, after] of [
        ["icon-192.png", "acme-192.png"],
        ["icon-512.png", "acme-512.png"],
        ["icon-maskable-512.png", "acme-maskable.png"],
        ["icon-monochrome.svg", "acme-symbol.svg"],
      ]
    ) {
      await Deno.rename(join(project, "public", before), join(project, "public", after));
    }
    const manifest = await readManifest(project);
    manifest.name = "Acme Field Notes";
    manifest.categories = ["productivity"];
    manifest.acme_optional_member = { enabled: true };
    const icons = manifest.icons as Array<Record<string, unknown>>;
    for (const icon of icons) {
      icon.src = String(icon.src)
        .replace("icon-192.png", "acme-192.png")
        .replace("icon-512.png", "acme-512.png")
        .replace("icon-maskable-512.png", "acme-maskable.png")
        .replace("icon-monochrome.svg", "acme-symbol.svg");
    }
    const monochrome = icons.find((icon) => icon.purpose === "monochrome");
    assert(monochrome, "starter fixture lost its monochrome icon");
    const shortcuts = manifest.shortcuts as Array<{ icons: Array<Record<string, unknown>> }>;
    shortcuts[0].icons[0].src = "./acme-192.png";
    await writeManifest(project, manifest);
    const issues = await sourcePwaIssues(project);
    assert(issues.length === 0, `replacement branding was rejected: ${JSON.stringify(issues)}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function makeProductionFixture(): Promise<string> {
  const root = await Deno.makeTempDir({ dir: ".", prefix: ".lofi-pwa-production-test-" });
  const dist = join(root, "dist");
  await Deno.mkdir(join(dist, "settings"), { recursive: true });
  const publicRoot = join(import.meta.dirname!, "../../apps/reference/public");
  const files: string[] = [];
  for await (const entry of Deno.readDir(publicRoot)) {
    if (!entry.isFile) continue;
    await Deno.copyFile(join(publicRoot, entry.name), join(dist, entry.name));
    files.push(entry.name);
  }
  const html =
    `<!doctype html><link rel="manifest" href="/field-notes/manifest.webmanifest"><link rel="apple-touch-icon" href="/field-notes/apple-touch-icon.png">`;
  await Deno.writeTextFile(join(dist, "index.html"), html);
  await Deno.writeTextFile(join(dist, "settings", "index.html"), html);
  await Deno.writeTextFile(
    join(dist, "lofi-build.json"),
    `${JSON.stringify({ sourceHash: "fixture-hash", basePath: "/field-notes/" })}\n`,
  );
  await Deno.writeTextFile(
    join(dist, "sw.js"),
    `const revision = "fixture-hash"; new URL("./lofi-precache.json", self.registration.scope);\n`,
  );
  await Deno.writeTextFile(
    join(dist, "lofi-schema.json"),
    `${JSON.stringify({ v: 1, revision: "fixture-hash", head: "v1:aa", lineage: ["v1:aa"] })}\n`,
  );
  files.push("index.html", "settings/index.html", "lofi-build.json", "lofi-schema.json", "sw.js");
  const manifest = JSON.parse(await Deno.readTextFile(join(dist, "manifest.webmanifest")));
  await Deno.writeTextFile(
    join(dist, "lofi-precache.json"),
    `${
      JSON.stringify(expectedPrecacheUrls(files, screenshotAssetPaths(manifest, "/field-notes/")))
    }\n`,
  );
  return root;
}

Deno.test("production PWA validation accepts one base-aware artifact set", async () => {
  const root = await makeProductionFixture();
  try {
    const issues = await productionPwaIssues(root, "/field-notes/");
    assert(issues.length === 0, `valid production fixture was rejected: ${JSON.stringify(issues)}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("production PWA validation catches nested links, precache drift, and worker drift", async () => {
  const root = await makeProductionFixture();
  try {
    const dist = join(root, "dist");
    await Deno.writeTextFile(
      join(dist, "settings", "index.html"),
      `<!doctype html><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/field-notes/apple-touch-icon.png">`,
    );
    await Deno.writeTextFile(join(dist, "lofi-precache.json"), `["./"]\n`);
    await Deno.writeTextFile(
      join(dist, "sw.js"),
      `new URL("./lofi-precache.json", self.registration.scope);\n`,
    );
    await Deno.writeTextFile(
      join(dist, "lofi-schema.json"),
      `${JSON.stringify({ v: 1, revision: "other-hash", head: "v1:aa", lineage: ["v1:aa"] })}\n`,
    );
    const manifest = JSON.parse(await Deno.readTextFile(join(dist, "manifest.webmanifest")));
    manifest.shortcuts[0].url = "./missing/";
    manifest.share_target = {
      action: "./share/",
      method: "GET",
      enctype: "application/x-www-form-urlencoded",
      params: { title: "title", text: "text", url: "url" },
    };
    manifest.file_handlers = [{
      action: "./import/",
      accept: { "application/json": [".json"] },
    }];
    manifest.protocol_handlers = [{ protocol: "web+lofi", url: "./open/?url=%s" }];
    await Deno.writeTextFile(
      join(dist, "manifest.webmanifest"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const issues = await productionPwaIssues(root, "/field-notes/");
    assert(hasIssue(issues, "settings/index.html: must link"), "nested manifest link drift passed");
    assert(hasIssue(issues, "entries do not match"), "precache drift passed");
    assert(hasIssue(issues, "build revision does not match"), "worker revision drift passed");
    assert(
      hasIssue(issues, "lofi-schema.json: schema compatibility manifest"),
      "schema manifest revision drift passed",
    );
    assert(hasIssue(issues, "has no emitted offline route"), "missing shortcut route passed");
    assert(
      hasIssue(issues, "share_target.action has no emitted offline route"),
      "missing share-target route passed",
    );
    assert(
      hasIssue(issues, "file_handlers[0].action has no emitted offline route"),
      "missing file-handler route passed",
    );
    assert(
      hasIssue(issues, "protocol_handlers[0].url has no emitted offline route"),
      "missing protocol-handler route passed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("production preview maps install-critical content types", () => {
  assert(
    productionContentType("manifest.webmanifest") === "application/manifest+json",
    "manifest MIME drifted",
  );
  assert(
    productionContentType("sw.js") === "text/javascript; charset=utf-8",
    "worker MIME drifted",
  );
  assert(
    productionContentType("lofi-precache.json") === "application/json; charset=utf-8",
    "precache MIME drifted",
  );
  assert(productionContentType("icon.webp") === "image/webp", "WebP MIME drifted");
});

Deno.test("a truncated PNG reports not decodable instead of throwing", async () => {
  const { root, project } = await makeProject();
  try {
    // A valid PNG signature and IHDR tag, truncated before the dimension bytes.
    const truncated = new Uint8Array([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
      0,
      0,
      0,
      13,
      73,
      72,
      68,
      82,
    ]);
    await Deno.writeFile(join(project, "public", "icon-192.png"), truncated);
    const issues = await sourcePwaIssues(project);
    assert(
      hasIssue(issues, "not decodable as image/png"),
      "a truncated image must produce the documented diagnostic, not a RangeError",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("encoded backslashes cannot escape the deployment scope", async () => {
  const { root, project } = await makeProject();
  try {
    const manifest = await readManifest(project);
    const icons = manifest.icons as Array<Record<string, unknown>>;
    icons[0] = { ...icons[0], src: "..%5C..%5Cicon-192.png" };
    await writeManifest(project, manifest);
    const issues = await sourcePwaIssues(project);
    assert(
      hasIssue(issues, "must stay inside deployment scope"),
      "an encoded-backslash path must be rejected as out of scope",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
