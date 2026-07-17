import { extname, join, relative } from "node:path";
import { normalizeDeploymentBase } from "./base-path.ts";

export type PwaValidationIssue = {
  detail: string;
  remediation: string;
};

type JsonObject = Record<string, unknown>;
type ImageResource = {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
};

const manifestFile = "manifest.webmanifest";
const syntheticOrigin = "https://lofi.invalid";
const displayModes = new Set(["browser", "fullscreen", "minimal-ui", "standalone"]);
const imageTypes = new Map([
  ["image/jpeg", new Set([".jpeg", ".jpg"])],
  ["image/png", new Set([".png"])],
  ["image/svg+xml", new Set([".svg"])],
  ["image/webp", new Set([".webp"])],
]);

function issue(detail: string, remediation: string): PwaValidationIssue {
  return { detail, remediation };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLikelyCssColor(value: unknown): boolean {
  if (!nonEmptyString(value) || /[;{}]/.test(value)) return false;
  const color = value.trim();
  return /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color) ||
    /^[a-z]+$/i.test(color) ||
    /^(?:color|hsl|hsla|hwb|lab|lch|oklab|oklch|rgb|rgba)\([^\n]+\)$/i.test(color);
}

function withinScope(target: URL, scope: URL): boolean {
  return target.origin === scope.origin && target.pathname.startsWith(scope.pathname);
}

function assetPath(url: URL, basePath: string): string | undefined {
  if (url.origin !== syntheticOrigin || !url.pathname.startsWith(basePath)) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.slice(basePath.length));
  } catch {
    return undefined;
  }
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === "..")) {
    return undefined;
  }
  return path;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return undefined;
  if (new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const ascii = (start: number, end: number) =>
    new TextDecoder().decode(bytes.subarray(start, end));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP") return undefined;
  const kind = ascii(12, 16);
  if (kind === "VP8X" && bytes.length >= 30) {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { width, height };
  }
  if (
    kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

async function imageDimensions(
  path: string,
  type: string,
): Promise<{ width: number; height: number } | undefined> {
  const bytes = await Deno.readFile(path);
  if (type === "image/png") return pngDimensions(bytes);
  if (type === "image/jpeg") return jpegDimensions(bytes);
  if (type === "image/webp") return webpDimensions(bytes);
  if (type === "image/svg+xml") {
    const source = new TextDecoder().decode(bytes);
    if (!/<svg\b/i.test(source)) return undefined;
    const viewBox = source.match(
      /\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i,
    );
    if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
    const width = source.match(/\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i);
    const height = source.match(/\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i);
    if (width && height) return { width: Number(width[1]), height: Number(height[1]) };
  }
  return undefined;
}

function declaredSizes(
  value: unknown,
): Array<{ width: number; height: number }> | "any" | undefined {
  if (!nonEmptyString(value)) return undefined;
  if (value.trim() === "any") return "any";
  const sizes: Array<{ width: number; height: number }> = [];
  for (const token of value.trim().split(/\s+/)) {
    const match = token.match(/^(\d+)x(\d+)$/i);
    if (!match) return undefined;
    sizes.push({ width: Number(match[1]), height: Number(match[2]) });
  }
  return sizes;
}

async function validateImages(
  value: unknown,
  member: string,
  assetRoot: string,
  manifestUrl: URL,
  scope: URL,
  basePath: string,
  remediation: string,
): Promise<{ issues: PwaValidationIssue[]; images: ImageResource[] }> {
  const issues: PwaValidationIssue[] = [];
  const images: ImageResource[] = [];
  if (!Array.isArray(value) || value.length === 0) {
    return {
      issues: [issue(`${manifestFile}: ${member} must be a non-empty array`, remediation)],
      images,
    };
  }
  for (const [index, raw] of value.entries()) {
    const label = `${manifestFile}: ${member}[${index}]`;
    if (!isObject(raw) || !nonEmptyString(raw.src)) {
      issues.push(issue(`${label}.src must be a non-empty URL`, remediation));
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw.src, manifestUrl);
    } catch {
      issues.push(issue(`${label}.src is not a valid URL`, remediation));
      continue;
    }
    const path = assetPath(url, basePath);
    if (!path || !withinScope(url, scope)) {
      issues.push(issue(`${label}.src must stay inside deployment scope ${basePath}`, remediation));
      continue;
    }
    if (!nonEmptyString(raw.type) || !imageTypes.has(raw.type)) {
      issues.push(issue(`${label}.type must name a supported image MIME type`, remediation));
      continue;
    }
    const extensions = imageTypes.get(raw.type)!;
    if (!extensions.has(extname(path).toLowerCase())) {
      issues.push(issue(`${label}.type does not match ${path}`, remediation));
      continue;
    }
    const sizes = declaredSizes(raw.sizes);
    if (!sizes) {
      issues.push(issue(`${label}.sizes must be "any" or WIDTHxHEIGHT tokens`, remediation));
      continue;
    }
    const fullPath = join(assetRoot, path);
    try {
      if (!(await Deno.stat(fullPath)).isFile) throw new Deno.errors.NotFound();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        issues.push(issue(`${label}.src references missing asset ${path}`, remediation));
        continue;
      }
      throw error;
    }
    const dimensions = await imageDimensions(fullPath, raw.type);
    if (!dimensions) {
      issues.push(issue(`${label}.src is not decodable as ${raw.type}`, remediation));
      continue;
    }
    if (
      sizes !== "any" &&
      !sizes.some((size) => size.width === dimensions.width && size.height === dimensions.height)
    ) {
      issues.push(
        issue(
          `${label}.sizes does not match ${path} (${dimensions.width}x${dimensions.height})`,
          remediation,
        ),
      );
      continue;
    }
    images.push({
      src: raw.src,
      sizes: raw.sizes as string,
      type: raw.type,
      purpose: nonEmptyString(raw.purpose) ? raw.purpose : undefined,
    });
  }
  return { issues, images };
}

async function parseAndValidateManifest(
  root: string,
  basePath: string,
  location: "public" | "dist",
): Promise<{ issues: PwaValidationIssue[]; manifest?: JsonObject; scope?: URL }> {
  const path = join(root, location, manifestFile);
  const remediation = location === "public"
    ? "edit public/manifest.webmanifest and its referenced assets, then rerun `deno task doctor`"
    : "fix the author-owned PWA source, then rerun `deno task build`";
  let manifest: unknown;
  try {
    manifest = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { issues: [issue(`${location}/${manifestFile}: file is missing`, remediation)] };
    }
    if (error instanceof SyntaxError) {
      return { issues: [issue(`${location}/${manifestFile}: malformed JSON`, remediation)] };
    }
    throw error;
  }
  if (!isObject(manifest)) {
    return {
      issues: [issue(`${location}/${manifestFile}: root must be a JSON object`, remediation)],
    };
  }

  const issues: PwaValidationIssue[] = [];
  for (const member of ["id", "name", "short_name", "start_url", "scope"] as const) {
    if (!nonEmptyString(manifest[member])) {
      issues.push(issue(`${manifestFile}: ${member} must be a non-empty string`, remediation));
    }
  }
  if (!displayModes.has(String(manifest.display))) {
    issues.push(
      issue(
        `${manifestFile}: display must be browser, fullscreen, minimal-ui, or standalone`,
        remediation,
      ),
    );
  }
  for (const member of ["background_color", "theme_color"] as const) {
    if (!isLikelyCssColor(manifest[member])) {
      issues.push(issue(`${manifestFile}: ${member} must be a CSS color`, remediation));
    }
  }

  const manifestUrl = new URL(`${syntheticOrigin}${basePath}${manifestFile}`);
  let startUrl: URL | undefined;
  let scope: URL | undefined;
  let identity: URL | undefined;
  for (
    const [member, value] of [
      ["id", manifest.id],
      ["start_url", manifest.start_url],
      ["scope", manifest.scope],
    ] as const
  ) {
    if (!nonEmptyString(value)) continue;
    try {
      const url = new URL(value, manifestUrl);
      if (url.origin !== syntheticOrigin) {
        issues.push(issue(`${manifestFile}: ${member} must be same-origin`, remediation));
      }
      if (member === "id") identity = url;
      else if (member === "start_url") startUrl = url;
      else scope = url;
    } catch {
      issues.push(issue(`${manifestFile}: ${member} is not a valid URL`, remediation));
    }
  }
  if (identity?.hash) {
    issues.push(issue(`${manifestFile}: id must not contain a fragment`, remediation));
  }
  if (scope && (scope.pathname !== basePath || scope.search || scope.hash)) {
    issues.push(
      issue(`${manifestFile}: scope must resolve to deployment base ${basePath}`, remediation),
    );
  }
  if (startUrl && scope && !withinScope(startUrl, scope)) {
    issues.push(issue(`${manifestFile}: start_url must stay inside scope`, remediation));
  }

  if (scope) {
    const icons = await validateImages(
      manifest.icons,
      "icons",
      join(root, location),
      manifestUrl,
      scope,
      basePath,
      remediation,
    );
    issues.push(...icons.issues);
    const hasPurposeSize = (purpose: string, size: number | "any") =>
      icons.images.some((image) => {
        const purposes = (image.purpose ?? "any").split(/\s+/);
        const sizes = declaredSizes(image.sizes);
        return purposes.includes(purpose) &&
          (size === "any" ? sizes === "any" : sizes === "any" ||
            sizes?.some((entry) => entry.width === size && entry.height === size));
      });
    for (const size of [192, 512]) {
      if (!hasPurposeSize("any", size)) {
        issues.push(
          issue(`${manifestFile}: icons need an any-purpose ${size}x${size} image`, remediation),
        );
      }
    }
    if (!hasPurposeSize("maskable", 512)) {
      issues.push(issue(`${manifestFile}: icons need a maskable 512x512 image`, remediation));
    }
    if (!hasPurposeSize("monochrome", "any")) {
      issues.push(issue(`${manifestFile}: icons need a scalable monochrome image`, remediation));
    }

    if (manifest.shortcuts !== undefined) {
      if (!Array.isArray(manifest.shortcuts)) {
        issues.push(issue(`${manifestFile}: shortcuts must be an array`, remediation));
      } else {
        for (const [index, raw] of manifest.shortcuts.entries()) {
          const label = `${manifestFile}: shortcuts[${index}]`;
          if (!isObject(raw) || !nonEmptyString(raw.name) || !nonEmptyString(raw.url)) {
            issues.push(issue(`${label} needs non-empty name and url strings`, remediation));
            continue;
          }
          try {
            const url = new URL(raw.url, manifestUrl);
            if (!withinScope(url, scope)) {
              issues.push(issue(`${label}.url must stay inside manifest scope`, remediation));
            }
          } catch {
            issues.push(issue(`${label}.url is not a valid URL`, remediation));
          }
          if (raw.icons !== undefined) {
            const shortcutIcons = await validateImages(
              raw.icons,
              `shortcuts[${index}].icons`,
              join(root, location),
              manifestUrl,
              scope,
              basePath,
              remediation,
            );
            issues.push(...shortcutIcons.issues);
          }
        }
      }
    }

    if (manifest.screenshots !== undefined) {
      const screenshots = await validateImages(
        manifest.screenshots,
        "screenshots",
        join(root, location),
        manifestUrl,
        scope,
        basePath,
        remediation,
      );
      issues.push(...screenshots.issues);
      const validSources = new Set(screenshots.images.map((image) => image.src));
      const formFactors = new Set<string>();
      if (Array.isArray(manifest.screenshots)) {
        for (const [index, raw] of manifest.screenshots.entries()) {
          if (!isObject(raw)) continue;
          const label = `${manifestFile}: screenshots[${index}]`;
          if (!nonEmptyString(raw.label)) {
            issues.push(issue(`${label}.label must describe the screenshot`, remediation));
          }
          if (raw.form_factor !== "narrow" && raw.form_factor !== "wide") {
            issues.push(
              issue(`${label}.form_factor must be narrow or wide`, remediation),
            );
          } else if (nonEmptyString(raw.src) && validSources.has(raw.src)) {
            formFactors.add(raw.form_factor);
          }
        }
      }
      for (const formFactor of ["narrow", "wide"]) {
        if (!formFactors.has(formFactor)) {
          issues.push(
            issue(
              `${manifestFile}: screenshots need a valid labeled ${formFactor} image`,
              remediation,
            ),
          );
        }
      }
    }

    if (manifest.share_target !== undefined) {
      const label = `${manifestFile}: share_target`;
      const target = manifest.share_target;
      if (!isObject(target)) {
        issues.push(issue(`${label} must be an object`, remediation));
      } else {
        if (!nonEmptyString(target.action)) {
          issues.push(issue(`${label}.action must be a non-empty URL`, remediation));
        } else {
          try {
            const action = new URL(target.action, manifestUrl);
            if (!withinScope(action, scope)) {
              issues.push(issue(`${label}.action must stay inside manifest scope`, remediation));
            }
            if (action.search || action.hash) {
              issues.push(
                issue(`${label}.action must not contain a query or fragment`, remediation),
              );
            }
          } catch {
            issues.push(issue(`${label}.action is not a valid URL`, remediation));
          }
        }
        if (target.method !== undefined && target.method !== "GET") {
          issues.push(
            issue(
              `${label}.method must be GET; POST and file shares require a custom worker recipe`,
              remediation,
            ),
          );
        }
        if (
          target.enctype !== undefined &&
          target.enctype !== "application/x-www-form-urlencoded"
        ) {
          issues.push(
            issue(`${label}.enctype must be application/x-www-form-urlencoded`, remediation),
          );
        }
        if (!isObject(target.params)) {
          issues.push(issue(`${label}.params must be an object`, remediation));
        } else {
          const names: string[] = [];
          for (const member of ["title", "text", "url"] as const) {
            const value = target.params[member];
            if (value === undefined) continue;
            if (!nonEmptyString(value)) {
              issues.push(
                issue(`${label}.params.${member} must be a non-empty string`, remediation),
              );
            } else names.push(value);
          }
          if (target.params.files !== undefined) {
            issues.push(
              issue(`${label}.params.files requires a POST/file-share worker recipe`, remediation),
            );
          }
          const unknown = Object.keys(target.params).filter((member) =>
            !["title", "text", "url", "files"].includes(member)
          );
          if (unknown.length > 0) {
            issues.push(issue(`${label}.params contains unsupported members`, remediation));
          }
          if (names.length === 0) {
            issues.push(issue(`${label}.params needs title, text, or url`, remediation));
          }
          if (new Set(names).size !== names.length) {
            issues.push(issue(`${label}.params names must be unique`, remediation));
          }
        }
      }
    }
  }
  return { issues, manifest, scope };
}

/** Validate author-owned manifest and referenced public assets before boot or build. */
export async function sourcePwaIssues(root: string, deploymentBase = "/") {
  return (await parseAndValidateManifest(root, normalizeDeploymentBase(deploymentBase), "public"))
    .issues;
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function links(html: string): Array<{ rel: string; href: string }> {
  return [...html.matchAll(/<link\b[^>]*>/gi)].flatMap((match) => {
    const rel = attribute(match[0], "rel");
    const href = attribute(match[0], "href");
    return rel && href ? [{ rel, href }] : [];
  });
}

function emittedRoutePath(url: URL, basePath: string): string | undefined {
  if (url.origin !== syntheticOrigin || !url.pathname.startsWith(basePath)) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.slice(basePath.length));
  } catch {
    return undefined;
  }
  if (path.split("/").some((part) => part === "..")) return undefined;
  if (!path) return "index.html";
  if (path.endsWith("/")) return `${path}index.html`;
  return path.endsWith(".html") ? path : `${path}/index.html`;
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string) {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory) await visit(child);
      else if (entry.isFile) files.push(relative(root, child).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return files.sort();
}

const precacheExcludedPaths = new Set(["lofi-build.json", "lofi-precache.json", "sw.js"]);

/** Returns manifest screenshot paths, which are install presentation rather than shell resources. */
export function screenshotAssetPaths(manifest: unknown, deploymentBase = "/"): string[] {
  if (!isObject(manifest) || !Array.isArray(manifest.screenshots)) return [];
  const basePath = normalizeDeploymentBase(deploymentBase);
  const manifestUrl = new URL(`${syntheticOrigin}${basePath}${manifestFile}`);
  return [
    ...new Set(manifest.screenshots.flatMap((raw) => {
      if (!isObject(raw) || !nonEmptyString(raw.src)) return [];
      try {
        const path = assetPath(new URL(raw.src, manifestUrl), basePath);
        return path ? [path] : [];
      } catch {
        return [];
      }
    })),
  ].sort();
}

/** Map build output paths to portable URLs expected in the service-worker precache. */
export function expectedPrecacheUrls(
  paths: readonly string[],
  presentationPaths: readonly string[] = [],
): string[] {
  const presentation = new Set(presentationPaths.map((path) => path.replaceAll("\\", "/")));
  return paths
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !precacheExcludedPaths.has(path) && !presentation.has(path))
    .map((path) => path === "index.html" ? "./" : `./${path}`)
    .sort();
}

/** MIME type used by the package preview for install-critical production files. */
export function productionContentType(path: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".webp": "image/webp",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Validate the emitted manifest, routes, worker, build identity, and precache as one artifact. */
export async function productionPwaIssues(root: string, deploymentBase = "/") {
  const basePath = normalizeDeploymentBase(deploymentBase);
  const dist = join(root, "dist");
  const remediation = "fix the author-owned PWA source, then rerun `deno task build`";
  const result = await parseAndValidateManifest(root, basePath, "dist");
  const issues = [...result.issues];
  let files: string[];
  try {
    files = await filesUnder(dist);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [issue("dist/: production output is missing", remediation)];
    }
    throw error;
  }

  let identity: JsonObject | undefined;
  try {
    const value = JSON.parse(await Deno.readTextFile(join(dist, "lofi-build.json")));
    if (isObject(value)) identity = value;
  } catch {
    // Report one stable error below.
  }
  if (
    !identity || !nonEmptyString(identity.sourceHash) || identity.basePath !== basePath
  ) {
    issues.push(
      issue("dist/lofi-build.json: build identity or deployment base is invalid", remediation),
    );
  }

  const htmlFiles = files.filter((path) => path.endsWith(".html"));
  if (htmlFiles.length === 0) {
    issues.push(issue("dist/: no prerendered HTML routes were emitted", remediation));
  }
  if (Array.isArray(result.manifest?.shortcuts)) {
    const manifestUrl = new URL(`${syntheticOrigin}${basePath}${manifestFile}`);
    for (const [index, raw] of result.manifest.shortcuts.entries()) {
      if (!isObject(raw) || !nonEmptyString(raw.url)) continue;
      try {
        const route = emittedRoutePath(new URL(raw.url, manifestUrl), basePath);
        if (!route || !htmlFiles.includes(route)) {
          issues.push(
            issue(
              `dist/${manifestFile}: shortcuts[${index}].url has no emitted offline route`,
              remediation,
            ),
          );
        }
      } catch {
        // Source validation already reports malformed shortcut URLs.
      }
    }
  }
  if (isObject(result.manifest?.share_target)) {
    const target = result.manifest.share_target;
    if (nonEmptyString(target.action)) {
      const manifestUrl = new URL(`${syntheticOrigin}${basePath}${manifestFile}`);
      try {
        const route = emittedRoutePath(new URL(target.action, manifestUrl), basePath);
        if (!route || !htmlFiles.includes(route)) {
          issues.push(
            issue(
              `dist/${manifestFile}: share_target.action has no emitted offline route`,
              remediation,
            ),
          );
        }
      } catch {
        // Source validation already reports malformed action URLs.
      }
    }
  }
  const expectedManifest = new URL(`${syntheticOrigin}${basePath}${manifestFile}`).href;
  const appleIcons = new Set<string>();
  for (const path of htmlFiles) {
    const html = await Deno.readTextFile(join(dist, path));
    const route = path === "index.html"
      ? basePath
      : `${basePath}${path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path}`;
    const documentUrl = new URL(route, syntheticOrigin);
    const pageLinks = links(html);
    const manifestLinks = pageLinks.filter((link) =>
      link.rel.toLowerCase().split(/\s+/).includes("manifest")
    );
    let linkedManifest = "";
    try {
      linkedManifest = new URL(manifestLinks[0]?.href ?? "", documentUrl).href;
    } catch {
      // The stable mismatch below names the route and intended manifest URL.
    }
    if (manifestLinks.length !== 1 || linkedManifest !== expectedManifest) {
      issues.push(
        issue(`dist/${path}: must link ${basePath}${manifestFile} exactly once`, remediation),
      );
    }
    const apple = pageLinks.find((link) =>
      link.rel.toLowerCase().split(/\s+/).includes("apple-touch-icon")
    );
    if (!apple) {
      issues.push(issue(`dist/${path}: Apple touch icon link is missing`, remediation));
    } else {
      try {
        const url = new URL(apple.href, documentUrl);
        const applePath = assetPath(url, basePath);
        if (!applePath) {
          issues.push(
            issue(`dist/${path}: Apple touch icon escapes deployment scope`, remediation),
          );
        } else appleIcons.add(applePath);
      } catch {
        issues.push(issue(`dist/${path}: Apple touch icon URL is invalid`, remediation));
      }
    }
  }
  for (const path of appleIcons) {
    try {
      const dimensions = await imageDimensions(join(dist, path), "image/png");
      if (!dimensions || dimensions.width !== 180 || dimensions.height !== 180) {
        issues.push(issue(`dist/${path}: Apple touch icon must be a 180x180 PNG`, remediation));
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        issues.push(issue(`dist/${path}: linked Apple touch icon is missing`, remediation));
      } else throw error;
    }
  }

  let precache: unknown;
  try {
    precache = JSON.parse(await Deno.readTextFile(join(dist, "lofi-precache.json")));
  } catch {
    issues.push(
      issue("dist/lofi-precache.json: missing or malformed precache manifest", remediation),
    );
  }
  const expectedPrecache = expectedPrecacheUrls(
    files,
    screenshotAssetPaths(result.manifest, basePath),
  );
  if (
    !Array.isArray(precache) || !precache.every((entry) => typeof entry === "string") ||
    JSON.stringify([...precache].sort()) !== JSON.stringify(expectedPrecache)
  ) {
    issues.push(
      issue("dist/lofi-precache.json: entries do not match the emitted shell", remediation),
    );
  } else {
    for (const entry of precache) {
      let url: URL | undefined;
      try {
        url = new URL(entry, `${syntheticOrigin}${basePath}`);
      } catch {
        // The scope failure below also covers malformed URLs.
      }
      if (!url || !withinScope(url, new URL(`${syntheticOrigin}${basePath}`))) {
        issues.push(
          issue(`dist/lofi-precache.json: ${entry} escapes deployment scope`, remediation),
        );
      }
    }
  }

  let worker = "";
  try {
    worker = await Deno.readTextFile(join(dist, "sw.js"));
  } catch {
    issues.push(issue("dist/sw.js: service worker is missing", remediation));
  }
  if (worker) {
    if (
      worker.includes("__LOFI_BUILD_REVISION__") ||
      !worker.includes(String(identity?.sourceHash ?? ""))
    ) {
      issues.push(issue("dist/sw.js: build revision does not match lofi-build.json", remediation));
    }
    if (!worker.includes('new URL("./lofi-precache.json", self.registration.scope)')) {
      issues.push(issue("dist/sw.js: precache URL is not relative to worker scope", remediation));
    }
  }
  return issues;
}
