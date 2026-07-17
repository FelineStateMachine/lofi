/**
 * Opt-in parser for a narrow custom-protocol collaborative-list deep link.
 *
 * @module
 */

/** A validated collaborative-list item reference, never an arbitrary redirect. */
export type CollaborativeListProtocolTarget = {
  readonly listId: string;
  readonly itemId: string;
};

/** Stable rejection that never contains the received protocol URL. */
export type CollaborativeListProtocolIssue =
  | "missing-target"
  | "duplicate-target"
  | "unexpected-parameter"
  | "target-too-long"
  | "invalid-target"
  | "wrong-protocol"
  | "unsupported-shape"
  | "invalid-list-id"
  | "invalid-item-id";

/** Accepted item reference or value-free rejection. */
export type CollaborativeListProtocolResult =
  | { ok: true; target: CollaborativeListProtocolTarget }
  | { ok: false; issue: CollaborativeListProtocolIssue };

/** Options matching one `protocol_handlers` manifest entry. */
export type ParseCollaborativeListProtocolOptions = {
  /** Exact custom scheme, such as `web+lofi`. */
  protocol: string;
  /** Handler-route query parameter receiving `%s`. Defaults to `url`. */
  parameter?: string;
  /** Maximum decoded protocol URL length. Defaults to 512. */
  maxLength?: number;
};

function configuredOptions(options: ParseCollaborativeListProtocolOptions): {
  protocol: string;
  parameter: string;
  maxLength: number;
} {
  if (!/^web\+[a-z]+$/.test(options.protocol)) {
    throw new TypeError("protocol must be a custom web+ scheme with lowercase ASCII letters");
  }
  const parameter = options.parameter ?? "url";
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(parameter)) {
    throw new TypeError("protocol query parameter must be a short lowercase name");
  }
  const maxLength = options.maxLength ?? 512;
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 4096) {
    throw new TypeError("protocol target length must be an integer from 1 to 4096");
  }
  return { protocol: options.protocol, parameter, maxLength };
}

/**
 * Decode the handler query once and allow-list one collaborative-list item.
 *
 * Expected payload: `web+scheme:collaborative-list/LIST_ID/item/ITEM_ID`.
 * IDs are restricted to portable unreserved characters, and the result contains
 * identifiers only. The received URL is never returned or used as a redirect.
 */
export function parseCollaborativeListProtocolTarget(
  search: string | URLSearchParams,
  options: ParseCollaborativeListProtocolOptions,
): CollaborativeListProtocolResult {
  const configured = configuredOptions(options);
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const unexpected = [...params.keys()].some((name) => name !== configured.parameter);
  if (unexpected) return { ok: false, issue: "unexpected-parameter" };
  const values = params.getAll(configured.parameter);
  if (values.length === 0) return { ok: false, issue: "missing-target" };
  if (values.length !== 1) return { ok: false, issue: "duplicate-target" };
  const value = values[0];
  if (value.length > configured.maxLength) return { ok: false, issue: "target-too-long" };
  // URLSearchParams has already decoded the query value. Reject remaining escapes
  // instead of applying a second decode with ambiguous semantics.
  if (value.includes("%")) return { ok: false, issue: "invalid-target" };
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return { ok: false, issue: "invalid-target" };
  }
  if (target.protocol !== `${configured.protocol}:`) {
    return { ok: false, issue: "wrong-protocol" };
  }
  if (target.search || target.hash || target.host || target.username || target.password) {
    return { ok: false, issue: "unsupported-shape" };
  }
  const segments = target.pathname.split("/");
  if (
    segments.length !== 4 || segments[0] !== "collaborative-list" || segments[2] !== "item"
  ) {
    return { ok: false, issue: "unsupported-shape" };
  }
  const identifier = /^[A-Za-z0-9_-]{1,64}$/;
  if (!identifier.test(segments[1])) return { ok: false, issue: "invalid-list-id" };
  if (!identifier.test(segments[3])) return { ok: false, issue: "invalid-item-id" };
  return { ok: true, target: { listId: segments[1], itemId: segments[3] } };
}
