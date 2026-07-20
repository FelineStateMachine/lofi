import type { VirtualAuthenticatorHandle } from "@nzip/lofi/testing";

/**
 * A worked example of the `@nzip/lofi/testing` WebAuthn helper: install a CDP
 * virtual authenticator and drive a device-credential enroll -> authenticate
 * round-trip against the running app.
 *
 * This is an opt-in browser gate, not part of `deno task test`:
 *   1. Serve the app on a stable origin — for example `deno task build` followed
 *      by `deno task preview`, or `deno task dev`. Enrollment is gated on a
 *      stable RP-ID, so add the served hostname to `credentialOrigins` in
 *      `src/app.ts` (127.0.0.1 is treated as local-only and refused).
 *   2. Point the test at that URL and run it directly:
 *        LOFI_E2E_BASE_URL=https://app.example.com/ deno test -A tests/auth_e2e_test.ts
 *
 * Without LOFI_E2E_BASE_URL (or without Chromium installed) it skips, so the
 * default suite stays fast and never launches a browser.
 *
 * NOTE: CDP virtual authenticators do not model the WebAuthn PRF extension, so
 * this example covers enroll/authenticate only. PRF derivation is feature-
 * detected in the runtime and must be validated on a real device.
 */

function e2eBaseURL(): string | undefined {
  // The default suite runs without --allow-env; treat a denied read as "skip".
  try {
    return Deno.env.get("LOFI_E2E_BASE_URL") || undefined;
  } catch {
    return undefined;
  }
}

// Runs inside the browser page, so it may only touch WebAuthn DOM APIs. A minimal
// inline enroll -> authenticate round-trip against the page's own origin (its
// RP-ID); returns the base64url credential id observed on both operations.
const roundTripCredential = async (
  rpId: string,
): Promise<{ enrolled: string; asserted: string }> => {
  const toBase64Url = (buffer: ArrayBuffer): string => {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  };
  const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

  const created = await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: "lofi auth example" },
      user: { id: randomBytes(16), name: "example", displayName: "example" },
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      timeout: 60_000,
    },
  }) as (PublicKeyCredential | null);
  if (!created) throw new Error("enrollment returned no credential");

  const asserted = await navigator.credentials.get({
    publicKey: {
      rpId,
      challenge: randomBytes(32),
      userVerification: "required",
      timeout: 60_000,
    },
  }) as (PublicKeyCredential | null);
  if (!asserted) throw new Error("authentication returned no credential");

  return {
    enrolled: toBase64Url(created.rawId),
    asserted: toBase64Url(asserted.rawId),
  };
};

Deno.test("a virtual authenticator drives an enroll -> authenticate round-trip", async () => {
  const baseURL = e2eBaseURL();
  if (!baseURL) {
    console.log(
      "skipping auth example; set LOFI_E2E_BASE_URL to a stable-origin deployment to run it",
    );
    return;
  }

  // Imported lazily so the default suite never loads Playwright.
  const { chromium } = await import("npm:playwright@1.61.1");
  const { BrowserUnavailableError, withVirtualAuthenticator } = await import("@nzip/lofi/testing");

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    // Match the fixture's missing-Chromium classification and skip cleanly.
    const message = error instanceof Error ? error.message : String(error);
    if (
      /executable doesn't exist|browser executable|playwright install|failed to launch/i.test(
        message,
      )
    ) {
      console.log(new BrowserUnavailableError({ cause: error }).message);
      return;
    }
    throw error;
  }

  let authenticator: VirtualAuthenticatorHandle | undefined;
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    authenticator = await withVirtualAuthenticator(page);
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });

    const rpId = new URL(baseURL).hostname;
    const result = await page.evaluate(roundTripCredential, rpId);
    if (result.enrolled !== result.asserted) {
      throw new Error("the authenticated credential id must match the enrolled id");
    }
  } finally {
    await authenticator?.dispose();
    await browser.close();
  }
});
