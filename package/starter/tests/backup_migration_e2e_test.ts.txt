import type { VirtualAuthenticatorHandle } from "@nzip/lofi/testing";

/**
 * A real-browser account journey: rows written local-only must survive the
 * election to back up and sync (the runtime copies them into the managed
 * namespace during the reload), and the phrase-reveal guard must accept only
 * its enrolled passkey.
 *
 * This is an opt-in browser gate, not part of `deno task test`:
 *   1. Configure managed sync (JAZZ_APP_ID + JAZZ_SERVER_URL in `.env`). The
 *      sync server does NOT need to be reachable — the migration completes at
 *      local durability, which is exactly what this test pins down.
 *   2. Serve the app on a hostname a passkey RP-ID can bind to — `localhost`
 *      works: `deno task build && deno task preview`, or `deno task dev`.
 *   3. Point the test at that URL and run it directly:
 *        LOFI_E2E_BASE_URL=http://localhost:4321/ deno test -A tests/backup_migration_e2e_test.ts
 *
 * Without LOFI_E2E_BASE_URL (or without Chromium installed) it skips, so the
 * default suite stays fast and never launches a browser.
 */

function e2eBaseURL(): string | undefined {
  // The default suite runs without --allow-env; treat a denied read as "skip".
  try {
    return Deno.env.get("LOFI_E2E_BASE_URL") || undefined;
  } catch {
    return undefined;
  }
}

// Runs inside the browser page: the status line reports "N item(s) …" once the
// local store has hydrated.
const taskListReady = () => {
  const status = document.querySelector('[data-island="tasks"] [role="status"]');
  return status !== null && /item\(s\)/.test(status.textContent ?? "");
};

Deno.test("local rows survive sync election and the phrase guard stays pinned", async () => {
  const baseURL = e2eBaseURL();
  if (!baseURL) {
    console.log(
      "skipping backup-migration journey; set LOFI_E2E_BASE_URL to a sync-configured deployment",
    );
    return;
  }

  // Imported lazily so the default suite never loads Playwright.
  const { chromium } = await import("npm:playwright@1.61.1");
  const { BrowserUnavailableError, waitForReady, withVirtualAuthenticator } = await import(
    "@nzip/lofi/testing"
  );

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
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
    await waitForReady(page, taskListReady, undefined, { description: "task list ready" });

    // Rows written while the account is still local-only.
    for (const text of ["survives migration", "second local row"]) {
      await page.fill("#new-task", text);
      await page.press("#new-task", "Enter");
      await page.locator(".task", { hasText: text }).first().waitFor({ timeout: 15_000 });
    }

    // Two-step backup: reveal the phrase, then confirm it is saved. The
    // confirmation reloads the document into the managed namespace.
    const enable = page.getByRole("button", { name: "Back up & enable sync" });
    try {
      await enable.waitFor({ timeout: 15_000 });
    } catch {
      throw new Error(
        "the backup gate never rendered — configure JAZZ_APP_ID and JAZZ_SERVER_URL in .env",
      );
    }
    await enable.click();
    const phraseWords = page.locator('[aria-label="Recovery phrase"] li');
    await phraseWords.first().waitFor({ timeout: 30_000 });
    if (await phraseWords.count() !== 24) {
      throw new Error("the revealed recovery phrase must contain 24 words");
    }
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.getByRole("button", { name: "I saved my phrase — enable sync" }).click(),
    ]);
    await waitForReady(page, taskListReady, undefined, { description: "managed runtime ready" });

    // The core regression: every local-only row is visible after the election,
    // with no sync server required — the migration settles at local tier.
    await page.getByRole("heading", { name: "Backed up & syncing" }).waitFor({ timeout: 30_000 });
    for (const text of ["survives migration", "second local row"]) {
      await page.locator(".task", { hasText: text }).first().waitFor({ timeout: 15_000 });
    }

    // Enroll the phrase-reveal guard, then reveal through the pinned ceremony
    // while the earlier recoverable-backup passkey is still present as a decoy
    // resident credential for the same RP ID.
    await page.getByRole("button", { name: "Add local phrase-reveal guard" }).click();
    await page.getByRole("button", { name: "Add local phrase-reveal guard" }).waitFor({
      state: "detached",
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Show recovery phrase" }).click();
    await phraseWords.first().waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Hide phrase" }).click();

    // Lose the device's credentials: the pinned ceremony must fail closed —
    // never reveal the phrase — rather than accept any remaining passkey.
    // (A no-match WebAuthn request can take up to its 60s timeout to reject.)
    await authenticator.clearCredentials();
    await page.getByRole("button", { name: "Show recovery phrase" }).click();
    await page.locator(".account-error").waitFor({ timeout: 90_000 });
    if (await phraseWords.count() !== 0) {
      throw new Error("the phrase was revealed without the enrolled guard credential");
    }
  } finally {
    await authenticator?.dispose();
    await browser.close();
  }
});
