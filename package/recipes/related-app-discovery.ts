/**
 * Opt-in presentation-only discovery for verified related applications.
 *
 * @module
 */

/** A product-owned related application declaration. */
export type VerifiedRelatedApplication = {
  readonly platform: string;
  readonly id?: string;
  readonly url?: string;
};

/** Minimal browser discovery client used by the recipe. */
export type RelatedApplicationClient = {
  getInstalledRelatedApps(): Promise<readonly unknown[]>;
};

/** Presentation-only discovery result. */
export type RelatedApplicationDiscovery =
  | { status: "unsupported" | "none" | "failed"; installed: readonly [] }
  | { status: "installed"; installed: readonly VerifiedRelatedApplication[] };

/** Options for matching browser results against product-owned declarations. */
export type DiscoverRelatedApplicationsOptions = {
  /** Declarations copied from a verified `related_applications` manifest entry. */
  allow: readonly VerifiedRelatedApplication[];
  /** Override the browser API for tests. */
  client?: RelatedApplicationClient;
};

/**
 * The one shared `related_applications` grammar: manifest validation imports
 * these so the validator can never accept a declaration this recipe rejects.
 */
export const relatedApplicationPlatforms: ReadonlySet<string> = new Set([
  "amazon",
  "chrome_web_store",
  "chromeos_play",
  "f-droid",
  "play",
  "webapp",
  "windows",
]);

/** Bounded, trimmed, control-character-free manifest string field. */
export function isBoundedManifestString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    value.length <= 512 && ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    });
}

const platforms = relatedApplicationPlatforms;
const nonEmptyBounded = isBoundedManifestString;

function normalizeDeclaration(value: VerifiedRelatedApplication): VerifiedRelatedApplication {
  if (!platforms.has(value.platform) || !nonEmptyBounded(value.id) && !nonEmptyBounded(value.url)) {
    throw new TypeError("related application needs a supported platform and an id or HTTPS URL");
  }
  let url: string | undefined;
  if (value.url !== undefined) {
    if (!nonEmptyBounded(value.url)) throw new TypeError("related application URL is invalid");
    const parsed = new URL(value.url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new TypeError("related application URL must be credential-free HTTPS");
    }
    url = parsed.href;
  }
  if (value.id !== undefined && !nonEmptyBounded(value.id)) {
    throw new TypeError("related application ID is invalid");
  }
  return { platform: value.platform, id: value.id, url };
}

function browserClient(): RelatedApplicationClient | undefined {
  if (typeof navigator === "undefined") return undefined;
  const candidate = navigator as Navigator & {
    getInstalledRelatedApps?: RelatedApplicationClient["getInstalledRelatedApps"];
  };
  return typeof candidate.getInstalledRelatedApps === "function"
    ? { getInstalledRelatedApps: candidate.getInstalledRelatedApps.bind(candidate) }
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Discover installed companions and return only exact allow-list matches.
 *
 * Use the result to adjust presentation such as redundant onboarding. It is
 * intentionally unsuitable for authentication or authorization: unknown fields
 * and versions are discarded, and errors degrade to the normal PWA experience.
 */
export async function discoverRelatedApplications(
  options: DiscoverRelatedApplicationsOptions,
): Promise<RelatedApplicationDiscovery> {
  const allow = options.allow.map(normalizeDeclaration);
  const keys = allow.map((entry) => JSON.stringify(entry));
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("related application declarations must not repeat");
  }
  const client = options.client ?? browserClient();
  if (!client) return { status: "unsupported", installed: [] };
  let values: readonly unknown[];
  try {
    values = await client.getInstalledRelatedApps();
  } catch {
    return { status: "failed", installed: [] };
  }
  if (!Array.isArray(values)) return { status: "failed", installed: [] };
  const installed = allow.filter((declaration) =>
    values.some((raw) => {
      if (!isObject(raw) || raw.platform !== declaration.platform) return false;
      if (declaration.id !== undefined && raw.id !== declaration.id) return false;
      if (declaration.url !== undefined) {
        if (typeof raw.url !== "string") return false;
        try {
          if (new URL(raw.url).href !== declaration.url) return false;
        } catch {
          return false;
        }
      }
      return true;
    })
  );
  return installed.length > 0
    ? { status: "installed", installed }
    : { status: "none", installed: [] };
}
