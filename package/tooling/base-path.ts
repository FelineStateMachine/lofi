/** Normalizes the public URL path where a generated application is mounted. */
export function normalizeDeploymentBase(value: string | undefined): string {
  const input = value?.trim() || "/";
  if (!input.startsWith("/") || input.startsWith("//")) {
    throw new Error("LOFI_BASE_PATH must be an absolute URL path beginning with one '/'");
  }
  if (input.includes("?") || input.includes("#") || input.includes("\\")) {
    throw new Error("LOFI_BASE_PATH must not contain a query, fragment, or backslash");
  }
  const segments = input.split("/").filter(Boolean);
  const encodedSegments: string[] = [];
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("LOFI_BASE_PATH contains invalid URL encoding");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("LOFI_BASE_PATH must not contain traversal or encoded path separators");
    }
    encodedSegments.push(encodeURIComponent(decoded));
  }
  return encodedSegments.length === 0 ? "/" : `/${encodedSegments.join("/")}/`;
}

/** Returns the request path relative to the configured deployment base. */
export function pathWithinDeploymentBase(pathname: string, base: string): string | null {
  const normalizedBase = normalizeDeploymentBase(base);
  if (normalizedBase === "/") return pathname.replace(/^\/+/, "");
  if (pathname === normalizedBase.slice(0, -1)) return "";
  if (!pathname.startsWith(normalizedBase)) return null;
  return pathname.slice(normalizedBase.length);
}
