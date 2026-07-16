import { BrowserUnavailableError, rethrowBrowserLaunchError } from "./browser_error.ts";
import { assertValueFreeState, redactDiagnosticText } from "./safety.ts";
import { readTraceArchive, sanitizeTraceArchive, writeTraceArchive } from "./trace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("value-free snapshots retain shape and reject values", () => {
  assertValueFreeState({ online: false, itemCount: 2, clients: [true, null] });
  for (
    const invalid of [
      { title: "private value" },
      { value: Number.NaN },
      new Date(),
    ]
  ) {
    let rejected = false;
    try {
      assertValueFreeState(invalid);
    } catch {
      rejected = true;
    }
    assert(rejected, `unsafe state was accepted: ${String(invalid)}`);
  }
});

Deno.test("missing Chromium reports the exact install command", () => {
  const cause = new Error("browser executable doesn't exist");
  try {
    rethrowBrowserLaunchError(cause);
  } catch (error) {
    assert(error instanceof BrowserUnavailableError, `unexpected error: ${error}`);
    assert(
      error.message.includes("deno run -A npm:playwright@1.61.1 install chromium"),
      error.message,
    );
    assert(error.cause === cause, "browser launch failure was not retained");
    return;
  }
  throw new Error("missing browser error was not thrown");
});

Deno.test("diagnostic redaction strips URL, JSON and literal credentials", () => {
  const input =
    'request https://user:pass@example.test/path?token=query#fragment {"authorization":"Bearer auth-value"} token=plain literal-value';
  const output = redactDiagnosticText(input, ["literal-value"]);
  assert(!output.includes("user:pass"), output);
  assert(!output.includes("query"), output);
  assert(!output.includes("fragment"), output);
  assert(!output.includes("auth-value"), output);
  assert(!output.includes("plain"), output);
  assert(!output.includes("literal-value"), output);
  assert(output.includes("https://example.test/path"), output);
});

Deno.test("trace archives are sanitized without losing their structure", async () => {
  const directory = await Deno.makeTempDir({ dir: "." });
  const path = `${directory}/trace.zip`;
  try {
    const trace =
      '{"type":"console","text":"token=trace-secret","authorization":"Bearer auth-secret"}\n';
    await Deno.writeFile(
      path,
      writeTraceArchive({
        "trace.trace": new TextEncoder().encode(trace),
        "resources/private.dat": new TextEncoder().encode("literal-private-resource"),
      }),
    );
    await sanitizeTraceArchive(path, (value) => redactDiagnosticText(value, ["trace-secret"]));
    const entries = await readTraceArchive(path);
    const result = new TextDecoder().decode(entries["trace.trace"]);
    assert(!result.includes("trace-secret"), result);
    assert(!result.includes("auth-secret"), result);
    assert(result.includes("[redacted]"), result);
    JSON.parse(result);
    assert(!("resources/private.dat" in entries), "private trace resource was retained");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
