/**
 * Content-Security-Policy tooling for the build: parse the per-page meta
 * policies Astro emits, union them into one deployable policy (hash unions
 * are additive allowances, so a single merged policy is valid for every
 * page), and report weakenings. The build reports and never gates — which
 * directives an app ships is the author's call; only the information is
 * mandatory.
 *
 * @module
 */

const META_PATTERN = /<meta\s+http-equiv="content-security-policy"\s+content="([^"]*)"\s*\/?>/i;

/** The CSP policy of one built page, or null when the page carries none. */
export function parseCspMeta(html: string): string | null {
  const match = html.match(META_PATTERN);
  if (!match) return null;
  return match[1].replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&")
    .trim();
}

function parsePolicy(policy: string): Map<string, Set<string>> {
  const directives = new Map<string, Set<string>>();
  for (const entry of policy.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [name, ...values] = trimmed.split(/\s+/);
    const existing = directives.get(name) ?? new Set<string>();
    for (const value of values) existing.add(value);
    directives.set(name, existing);
  }
  return directives;
}

/** Unions per-page policies into one policy valid for every page. */
export function mergeCspPolicies(policies: readonly string[]): string {
  const merged = new Map<string, Set<string>>();
  for (const policy of policies) {
    for (const [name, values] of parsePolicy(policy)) {
      const existing = merged.get(name) ?? new Set<string>();
      for (const value of values) existing.add(value);
      merged.set(name, existing);
    }
  }
  return [...merged.entries()]
    .map(([name, values]) => [name, ...values].join(" "))
    .join("; ");
}

/** Findings worth surfacing about a policy; empty means nothing to report. */
export function cspPolicyWarnings(policy: string): string[] {
  const warnings: string[] = [];
  const directives = parsePolicy(policy);
  const scripts = directives.get("script-src") ?? new Set<string>();
  if (scripts.has("'unsafe-inline'")) {
    warnings.push("script-src allows 'unsafe-inline', which disables the injection protection");
  }
  if (scripts.has("'unsafe-eval'")) {
    warnings.push("script-src allows 'unsafe-eval'");
  }
  const remote = [...scripts].filter((value) =>
    !value.startsWith("'") && value !== "blob:" && value !== "data:"
  );
  if (remote.length > 0) {
    warnings.push(`script-src admits remote origins: ${remote.join(", ")}`);
  }
  return warnings;
}

/**
 * A commented header snippet for hosts that support response headers. The
 * meta tag already enforces the policy everywhere; a real header adds the
 * directives a meta tag cannot carry (frame-ancestors) and governs the
 * service worker's own execution.
 */
export function renderHeadersSnippet(policy: string): string {
  return [
    "# Content-Security-Policy for hosts that support response headers.",
    "# The built pages already enforce this policy via a meta tag; a real",
    "# header additionally covers frame-ancestors (ignored in meta by spec)",
    "# and the service worker script itself (sw.js). Adapt the syntax to",
    "# your host (this file uses the Netlify/Cloudflare _headers format).",
    "/*",
    `  Content-Security-Policy: ${policy}; frame-ancestors 'none'`,
    "",
  ].join("\n");
}
