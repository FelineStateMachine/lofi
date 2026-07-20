/**
 * A real, worked example of the `@nzip/lofi/testing` browser scenario: two
 * browser clients each add a task while offline, then reconnect and converge
 * on both.
 *
 * This is an opt-in browser gate, not part of `deno task test`:
 *   1. Configure managed sync (JAZZ_APP_ID + JAZZ_SERVER_URL in .env) with the
 *      schema deployed to that store, then serve the app — for example
 *      `deno task build` followed by `deno task preview`, or `deno task dev`.
 *   2. Point the test at that URL — it must be `localhost`, not `127.0.0.1`,
 *      because the sync election enrolls a passkey and an IP address is not a
 *      valid WebAuthn RP ID — and run it directly:
 *        LOFI_E2E_BASE_URL=http://localhost:4321/ deno test -A tests/convergence_e2e_test.ts
 *
 * The primary client performs the real backup-and-sync election (with a
 * virtual authenticator) before its state is cloned: lofi is local-only by
 * design until the account opts in, so without the election there is nothing
 * to converge and the gate would fail for a reason that indicts no one.
 *
 * Without LOFI_E2E_BASE_URL (or without Chromium installed) it skips, so the
 * default suite stays fast and never launches a browser.
 */

import type { BrowserScenarioPeer } from "@nzip/lofi/testing";

function e2eBaseURL(): string | undefined {
  // The default suite runs without --allow-env; treat a denied read as "skip".
  try {
    return Deno.env.get("LOFI_E2E_BASE_URL") || undefined;
  } catch {
    return undefined;
  }
}

// Runs inside the browser page, so it may only touch DOM APIs: the status line
// reports "N item(s) …" once the local store has hydrated.
const taskListReady = () => {
  const status = document.querySelector('[role="status"]');
  return status !== null && /item\(s\)/.test(status.textContent ?? "");
};

const baseURL = e2eBaseURL();
if (baseURL === undefined) {
  Deno.test("two clients converge on concurrent offline task edits", () => {
    console.log(
      "skipping convergence example; set LOFI_E2E_BASE_URL to a synced deployment to run it",
    );
  });
} else {
  // Imported lazily so the default suite never loads Playwright.
  const { scenario, waitForReady, withVirtualAuthenticator } = await import("@nzip/lofi/testing");

  const ready = (peer: BrowserScenarioPeer) =>
    waitForReady(peer.page, taskListReady, undefined, { description: `${peer.name} ready` });
  const addTask = async (peer: BrowserScenarioPeer, text: string) => {
    await peer.page.fill("#new-task", text);
    await peer.page.press("#new-task", "Enter");
  };
  const seeTask = (peer: BrowserScenarioPeer, text: string) =>
    peer.page.locator(".task", { hasText: text }).first().waitFor({
      state: "visible",
      timeout: 15_000,
    });

  scenario.browser("two clients converge on concurrent offline task edits", {
    baseURL,
    // Shared identity clones the first client's state in memory after the
    // election, so both browser contexts act as the same synced account. The
    // election runs through the real account UI.
    identity: {
      mode: "shared",
      preparePrimary: async (client) => {
        const readyPage = () =>
          waitForReady(client.page, taskListReady, undefined, { description: "primary ready" });
        await readyPage();
        await withVirtualAuthenticator(client.page);
        await client.page.getByRole("button", { name: "Back up & enable sync" }).click();
        await client.page.locator('[aria-label="Recovery phrase"] li').first().waitFor({
          state: "visible",
          timeout: 30_000,
        });
        await client.page.getByRole("button", { name: "I saved my phrase — enable sync" }).click();
        await client.page.getByRole("heading", { name: "Backed up & syncing" }).waitFor({
          state: "visible",
          timeout: 30_000,
        });
        await readyPage();
      },
    },
    ready,
    // Failure artifacts stay value-free: counts and booleans only, no task text.
    snapshot: async (peer) => ({
      online: !peer.isOffline,
      items: await peer.page.locator(".task").count(),
    }),
    artifacts: { directory: "test-results" },
  }, async ({ alice, bob }) => {
    await alice.offline();
    await bob.offline();
    await addTask(alice, "first client task");
    await addTask(bob, "second client task");
    await seeTask(alice, "first client task");
    await seeTask(bob, "second client task");
    await alice.online();
    await bob.online();

    // App-owned convergence: both tasks visible on both peers.
    for (const peer of [alice, bob]) {
      await seeTask(peer, "first client task");
      await seeTask(peer, "second client task");
    }
  });
}
