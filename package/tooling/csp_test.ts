// CSP tooling contract: meta parsing, policy union, warning analysis, and
// the header snippet.
import { cspPolicyWarnings, mergeCspPolicies, parseCspMeta, renderHeadersSnippet } from "./csp.ts";
import { assert } from "../runtime/test-assert.ts";

Deno.test("parseCspMeta extracts and entity-decodes the policy", () => {
  const html = `<html><head><meta http-equiv="content-security-policy" content="script-src ` +
    `&#39;self&#39; &#39;sha256-abc&#39;; style-src &#39;self&#39;"></head><body></body></html>`;
  const policy = parseCspMeta(html);
  assert(
    policy === "script-src 'self' 'sha256-abc'; style-src 'self'",
    `unexpected parse: ${policy}`,
  );
  assert(parseCspMeta("<html><head></head></html>") === null, "no meta must parse to null");
});

Deno.test("mergeCspPolicies unions directive values and dedupes", () => {
  const merged = mergeCspPolicies([
    "script-src 'self' 'sha256-a'; style-src 'self'",
    "script-src 'self' 'sha256-b'; style-src 'self' 'sha256-s'; object-src 'none'",
  ]);
  assert(
    merged === "script-src 'self' 'sha256-a' 'sha256-b'; style-src 'self' 'sha256-s'; " +
        "object-src 'none'",
    `unexpected union: ${merged}`,
  );
});

Deno.test("cspPolicyWarnings flags weakenings and stays quiet otherwise", () => {
  const clean = cspPolicyWarnings(
    "script-src 'self' 'wasm-unsafe-eval' 'sha256-a'; object-src 'none'",
  );
  assert(clean.length === 0, `clean policy warned: ${clean.join(" | ")}`);
  const inline = cspPolicyWarnings("script-src 'self' 'unsafe-inline'");
  assert(inline.some((w) => w.includes("unsafe-inline")), "unsafe-inline must warn");
  const remote = cspPolicyWarnings("script-src 'self' https://cdn.example.com");
  assert(remote.some((w) => w.includes("cdn.example.com")), "remote origins must warn");
});

Deno.test("the headers snippet carries the policy and frame-ancestors", () => {
  const snippet = renderHeadersSnippet("script-src 'self'");
  assert(
    snippet.includes("Content-Security-Policy: script-src 'self'; frame-ancestors 'none'"),
    "snippet must render the full header",
  );
  assert(snippet.startsWith("#"), "snippet must lead with its commentary");
});
