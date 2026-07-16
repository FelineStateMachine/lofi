import type {
  BrowserTestClient,
  ConcurrentOfflineScenario,
  TwoClientFixture,
} from "@nzip/lofi/testing";

/**
 * A real, worked example of the `@nzip/lofi/testing` toolkit: two browser
 * clients each add a task while offline, then reconnect and converge on both.
 *
 * This is an opt-in browser gate, not part of `deno task test`:
 *   1. Configure managed sync (JAZZ_APP_ID + JAZZ_SERVER_URL in .env) so two
 *      clients share one synced account, then serve the app — for example
 *      `deno task build` followed by `deno task preview`, or `deno task dev`.
 *   2. Point the test at that URL and run it directly:
 *        LOFI_E2E_BASE_URL=http://127.0.0.1:4321/ deno test -A tests/convergence_e2e_test.ts
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

// Runs inside the browser page, so it may only touch DOM APIs: the status line
// reports "N item(s) …" once the local store has hydrated.
const taskListReady = () => {
  const status = document.querySelector('[role="status"]');
  return status !== null && /item\(s\)/.test(status.textContent ?? "");
};

Deno.test("two clients converge on concurrent offline task edits", async () => {
  const baseURL = e2eBaseURL();
  if (!baseURL) {
    console.log(
      "skipping convergence example; set LOFI_E2E_BASE_URL to a synced deployment to run it",
    );
    return;
  }

  // Imported lazily so the default suite never loads Playwright.
  const {
    BrowserUnavailableError,
    createTwoClientFixture,
    runConcurrentOfflineConvergence,
    waitForReady,
  } = await import("@nzip/lofi/testing");

  const ready = (client: BrowserTestClient) =>
    waitForReady(client.page, taskListReady, undefined, { description: `${client.name} ready` });
  const addTask = async (client: BrowserTestClient, text: string) => {
    await client.page.fill("#new-task", text);
    await client.page.press("#new-task", "Enter");
  };
  const seeTask = (client: BrowserTestClient, text: string) =>
    client.page.locator(".task", { hasText: text }).first().waitFor({
      state: "visible",
      timeout: 15_000,
    });

  let fixture: TwoClientFixture | undefined;
  try {
    fixture = await createTwoClientFixture({
      baseURL,
      // Shared identity clones the first client's device key in memory, so both
      // browser contexts act as the same synced account.
      identity: { mode: "shared", preparePrimary: ready },
      artifacts: { directory: "test-results" },
    });
  } catch (error) {
    if (error instanceof BrowserUnavailableError) {
      console.log(error.message);
      return;
    }
    throw error;
  }

  try {
    const scenario: ConcurrentOfflineScenario<string> = {
      edits: ["first client task", "second client task"],
      ready,
      apply: addTask,
      locallyApplied: seeTask,
      converged: async ({ clients }) => {
        await Promise.all(clients.map((client) =>
          Promise.all([
            seeTask(client, "first client task"),
            seeTask(client, "second client task"),
          ])
        ));
      },
      // Failure artifacts stay value-free: counts and booleans only, no task text.
      snapshot: async (client) => ({
        online: !client.offline,
        items: await client.page.locator(".task").count(),
      }),
      failureLabel: "task-convergence",
    };
    await runConcurrentOfflineConvergence(fixture, scenario);
  } finally {
    await fixture.close();
  }
});
