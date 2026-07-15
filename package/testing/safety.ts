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

/** Redacts common credential forms before diagnostics are retained in memory. */
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
 * State artifacts intentionally reject strings and non-finite numbers. Callers
 * can record shape, counts and booleans, but not user values or credentials.
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

export function artifactName(value: string): string {
  const safe = value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return safe || "failure";
}
