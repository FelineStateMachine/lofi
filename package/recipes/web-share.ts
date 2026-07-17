/**
 * Opt-in helpers for outbound Web Share and inbound text/link share targets.
 *
 * The helpers feature-detect browser support and parse received values without
 * mutating application data. Add the matching manifest member and receiver UI
 * only when the product has a concrete sharing workflow.
 *
 * @module
 */

/** Data accepted by the browser Web Share API. */
export type WebShareData = {
  title?: string;
  text?: string;
  url?: string;
  files?: readonly File[];
};

/** Minimal browser seam used by {@link shareOrFallback}. */
export type WebShareClient = {
  canShare?: (data: WebShareData) => boolean;
  share?: (data: WebShareData) => Promise<void>;
};

/** Stable, value-free outcome from one outbound share attempt. */
export type WebShareOutcome = "shared" | "cancelled" | "fallback" | "failed";

/** Browser seam and fallback used for one outbound share attempt. */
export type ShareOrFallbackOptions = {
  /** Override the browser seam for tests or non-window environments. */
  client?: WebShareClient;
  /** Normal web action used when native sharing is unavailable. */
  fallback: (data: WebShareData) => void | Promise<void>;
};

function browserShareClient(): WebShareClient | undefined {
  if (!("navigator" in globalThis)) return undefined;
  const candidate = globalThis.navigator as Navigator & WebShareClient;
  return candidate;
}

function cancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Attempt a user-triggered native share and use a normal web fallback only
 * when the capability is unavailable or rejects the payload up front.
 *
 * Call this function directly from a click/submit handler: browsers require
 * transient user activation for `navigator.share()`. A runtime share failure
 * is reported as `failed` so callers can offer a retry or explicit copy action
 * without unexpectedly copying data after the native sheet opened.
 */
export async function shareOrFallback(
  data: WebShareData,
  options: ShareOrFallbackOptions,
): Promise<WebShareOutcome> {
  const client = options.client ?? browserShareClient();
  if (!client?.share) {
    await options.fallback(data);
    return "fallback";
  }
  if (client.canShare) {
    try {
      if (!client.canShare(data)) {
        await options.fallback(data);
        return "fallback";
      }
    } catch {
      await options.fallback(data);
      return "fallback";
    }
  }
  try {
    await client.share(data);
    return "shared";
  } catch (error) {
    return cancelled(error) ? "cancelled" : "failed";
  }
}

/** Length limits applied to received title, text, and URL values. */
export type TextShareTargetLimits = {
  title: number;
  text: number;
  url: number;
};

/** Default limits for the text/link share-target recipe. */
export const TEXT_SHARE_LIMITS: Readonly<TextShareTargetLimits> = {
  title: 120,
  text: 2_000,
  url: 2_048,
} as const;

/** Query-parameter names declared by the matching manifest share target. */
export type TextShareTargetNames = {
  title: string;
  text: string;
  url: string;
};

/** Parsed text/link values awaiting explicit user confirmation. */
export type TextShareTargetDraft = {
  title?: string;
  text?: string;
  url?: string;
};

/** Stable validation issue that never contains received share values. */
export type TextShareTargetIssue =
  | "duplicate-title"
  | "duplicate-text"
  | "duplicate-url"
  | "title-too-long"
  | "text-too-long"
  | "url-too-long"
  | "invalid-url"
  | "unsupported-url-protocol"
  | "empty-share";

/** Accepted draft or value-free rejection from an inbound share target. */
export type TextShareTargetResult =
  | { ok: true; draft: TextShareTargetDraft; issues: readonly [] }
  | { ok: false; issues: readonly TextShareTargetIssue[] };

/** Optional manifest-name and input-limit overrides for the inbound parser. */
export type ParseTextShareTargetOptions = {
  names?: Partial<TextShareTargetNames>;
  limits?: Partial<TextShareTargetLimits>;
};

const defaultNames: TextShareTargetNames = { title: "title", text: "text", url: "url" };

/**
 * Parse an inbound GET share target as an untrusted draft.
 *
 * Unknown parameters are ignored. Duplicate, oversized, malformed, and
 * non-HTTP(S) values reject the whole draft. The caller must still present the
 * returned draft for explicit user confirmation before persisting anything.
 */
export function parseTextShareTarget(
  input: URL | URLSearchParams | string,
  options: ParseTextShareTargetOptions = {},
): TextShareTargetResult {
  const parameters = input instanceof URL
    ? input.searchParams
    : input instanceof URLSearchParams
    ? input
    : new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  const names = { ...defaultNames, ...options.names };
  const limits = { ...TEXT_SHARE_LIMITS, ...options.limits };
  const issues: TextShareTargetIssue[] = [];
  const draft: TextShareTargetDraft = {};

  const read = (field: keyof TextShareTargetNames): string | undefined => {
    const values = parameters.getAll(names[field]);
    if (values.length > 1) {
      issues.push(`duplicate-${field}` as TextShareTargetIssue);
      return undefined;
    }
    const value = values[0]?.trim();
    if (!value) return undefined;
    if (value.length > limits[field]) {
      issues.push(`${field}-too-long` as TextShareTargetIssue);
      return undefined;
    }
    return value;
  };

  draft.title = read("title");
  draft.text = read("text");
  const rawUrl = read("url");
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        issues.push("unsupported-url-protocol");
      } else {
        draft.url = parsed.href;
      }
    } catch {
      issues.push("invalid-url");
    }
  }
  if (!draft.title && !draft.text && !draft.url && issues.length === 0) {
    issues.push("empty-share");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, draft, issues: [] };
}
