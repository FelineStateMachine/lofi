/**
 * Opt-in deployment helpers for reciprocal PWA scope extensions.
 *
 * @module
 */

/** A manifest `scope_extensions` entry owned by this product. */
export type ScopeExtensionDeclaration = {
  readonly type: "origin";
  readonly origin: string;
};

/** The value published under an exact manifest ID in an origin association file. */
export type WebAppOriginAssociationEntry = {
  readonly scope: string;
};

/** Options shared by association generation and verification. */
export type WebAppOriginAssociationOptions = {
  /** Exact absolute manifest ID, including any path. */
  manifestId: string;
  /** Absolute-path scope hosted by the extending origin. */
  scope: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeManifestId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new TypeError("manifest ID must be a bounded absolute HTTPS URL");
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search ||
    parsed.hash || parsed.href !== value
  ) {
    throw new TypeError(
      "manifest ID must be an exact credential-free HTTPS URL without query or fragment",
    );
  }
  return parsed.href;
}

function normalizeOrigin(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new TypeError("scope extension origin must be a bounded HTTPS origin");
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash || parsed.origin !== value
  ) {
    throw new TypeError("scope extension origin must be an exact credential-free HTTPS origin");
  }
  return parsed.origin;
}

function normalizeScope(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 2048 ||
    !value.startsWith("/") || value.startsWith("//") || value.includes("\\")
  ) {
    throw new TypeError("association scope must be a bounded absolute path");
  }
  const parsed = new URL(value, "https://scope.invalid");
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    throw new TypeError("association scope must have valid path encoding");
  }
  if (
    parsed.origin !== "https://scope.invalid" || parsed.search || parsed.hash ||
    decoded.split("/").some((segment) => segment === "." || segment === "..") ||
    parsed.pathname !== value
  ) {
    throw new TypeError("association scope must be a normalized absolute path without traversal");
  }
  return parsed.pathname;
}

/** Create one validated manifest declaration without adding it to the starter. */
export function createScopeExtension(origin: string): ScopeExtensionDeclaration {
  return { type: "origin", origin: normalizeOrigin(origin) };
}

/**
 * Create the JSON value for `/.well-known/web-app-origin-association`.
 *
 * Deploy this file on the extending origin before adding its declaration to
 * the primary app manifest.
 */
export function createWebAppOriginAssociation(
  options: WebAppOriginAssociationOptions,
): Readonly<Record<string, WebAppOriginAssociationEntry>> {
  const manifestId = normalizeManifestId(options.manifestId);
  return { [manifestId]: { scope: normalizeScope(options.scope) } };
}

/**
 * Verify that unknown association JSON contains the exact manifest ID and scope.
 * Extra manifest entries are allowed, but the matched entry may contain only `scope`.
 */
export function verifyWebAppOriginAssociation(
  value: unknown,
  options: WebAppOriginAssociationOptions,
): boolean {
  const manifestId = normalizeManifestId(options.manifestId);
  const scope = normalizeScope(options.scope);
  if (!isObject(value)) return false;
  const entry = value[manifestId];
  return isObject(entry) && Object.keys(entry).length === 1 && entry.scope === scope;
}
