/**
 * Value-free failure-artifact safety: the {@link ValueFreeState} shape rule for
 * state snapshots, its {@link assertValueFreeState} validator, and the
 * {@link redactDiagnosticText} credential redaction applied to retained
 * diagnostics.
 *
 * @module
 */

/**
 * A JSON-like value restricted to booleans, finite numbers, arrays, and plain
 * objects. Strings are excluded so state snapshots record shape and counts but
 * never user values or credentials.
 */
export type ValueFreeState =
  | null
  | boolean
  | number
  | { readonly [key: string]: ValueFreeState }
  | readonly ValueFreeState[];

const JSON_SECRET_ASSIGNMENT =
  /(\"(?:password|passwd|secret|token|authorization|cookie|credential|session)\"\s*:\s*)\"(?:\\.|[^\"])*\"/gi;
const SECRET_ASSIGNMENT =
  /\b(password|passwd|secret|token|authorization|cookie|credential|session)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_VALUE = /https?:\/\/[^\s"'<>]+/gi;

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * Redact common credential forms from diagnostic text: URL userinfo, query,
 * and fragment components; JSON and `key=value` secret assignments; bearer
 * tokens; and every literal in `secretValues`. The fixtures apply this to all
 * retained diagnostics; apply it likewise to any custom capture path.
 *
 * @param value The diagnostic text to redact.
 * @param secretValues Literal credential values to remove wherever they appear.
 * @returns The text with credential forms replaced by `[redacted]` markers.
 */
export function redactDiagnosticText(
  value: string,
  secretValues: readonly string[] = [],
): string {
  let redacted = value
    .replaceAll(URL_VALUE, (url) => safeUrl(url))
    .replaceAll(JSON_SECRET_ASSIGNMENT, '$1"[redacted]"')
    .replaceAll(BEARER_VALUE, "Bearer [redacted]")
    .replaceAll(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[redacted]`);
  for (const secret of secretValues) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

/**
 * Assert that `value` satisfies the value-free rule: strings and non-finite
 * numbers are rejected, so state artifacts record shape, counts, and booleans
 * but never user values or credentials. Snapshot callbacks passed to the
 * fixtures are validated with this at capture time; call it directly to
 * pre-validate a `snapshot` callback's output in a fast test.
 *
 * @param value The candidate snapshot value.
 * @param path The label used for the offending location in error messages.
 * @throws {TypeError} When `value` contains a string or an unsupported value.
 */
export function assertValueFreeState(
  value: unknown,
  path = "state",
): asserts value is ValueFreeState {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string") {
    throw new TypeError(`${path} contains a string value; state artifacts must be value-free`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertValueFreeState(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, entry] of Object.entries(value)) {
      assertValueFreeState(entry, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} contains an unsupported value`);
}

/**
 * Normalize a label into a filesystem-safe artifact directory name, falling
 * back to `"failure"` when nothing usable remains.
 */
export function artifactName(value: string): string {
  const safe = value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return safe || "failure";
}
