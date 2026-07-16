import {
  BrowserUnavailableError,
  createTwoClientFixture,
  type TwoClientFixture,
} from "./fixture.ts";
import { waitForReady } from "./readiness.ts";
import { readTraceArchive } from "./trace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("real Chromium fixture isolates or shares identity in memory and captures safe failures", async () => {
  const artifacts = await Deno.makeTempDir({ dir: "." });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      new Response(
        `<!doctype html>
        <html><body data-ready="yes"><main>fixture</main></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
  );
  const address = server.addr as Deno.NetAddr;
  const baseURL = `http://127.0.0.1:${address.port}/`;
  let shared: TwoClientFixture | undefined;
  let isolated: TwoClientFixture | undefined;

  try {
    try {
      shared = await createTwoClientFixture({
        baseURL,
        identity: {
          mode: "shared",
          async preparePrimary(client) {
            await client.page.evaluate(() => localStorage.setItem("identity", "shared-person"));
          },
        },
        artifacts: { directory: artifacts, secretValues: ["literal-secret"] },
      });
    } catch (error) {
      if (error instanceof BrowserUnavailableError) return;
      throw error;
    }

    await Promise.all(
      shared.clients.map((client) =>
        waitForReady(
          client.page,
          (value) => document.body.dataset.ready === value,
          "yes",
          { description: `${client.name} boot` },
        )
      ),
    );
    const sharedIdentities = await Promise.all(
      shared.clients.map((client) => client.page.evaluate(() => localStorage.getItem("identity"))),
    );
    assert(
      sharedIdentities.join(",") === "shared-person,shared-person",
      `shared state was not cloned: ${sharedIdentities}`,
    );

    await shared.first.reloadPage();
    assert(
      await shared.first.page.evaluate(() => localStorage.getItem("identity")) === "shared-person",
      "page reload lost identity",
    );

    await shared.goOffline();
    await Promise.all(
      shared.clients.map((client) => client.page.waitForFunction(() => navigator.onLine === false)),
    );
    await shared.goOnline();
    await Promise.all(
      shared.clients.map((client) => client.page.waitForFunction(() => navigator.onLine === true)),
    );

    await shared.first.restartPage();
    assert(
      await shared.first.page.evaluate(() => localStorage.getItem("identity")) === "shared-person",
      "page restart lost identity",
    );
    await shared.second.restartClient();
    assert(
      await shared.second.page.evaluate(() => localStorage.getItem("identity")) === "shared-person",
      "client restart lost in-memory identity",
    );

    isolated = await createTwoClientFixture({
      baseURL,
      browser: shared.browser,
      identity: {
        mode: "isolated",
        async prepare(client) {
          await client.page.evaluate(
            (identity) => localStorage.setItem("identity", identity),
            `${client.name}-person`,
          );
        },
      },
      traceOnFailure: false,
    });
    const isolatedIdentities = await Promise.all(
      isolated.clients.map((client) =>
        client.page.evaluate(() => localStorage.getItem("identity"))
      ),
    );
    assert(
      isolatedIdentities.join(",") === "first-person,second-person",
      `isolated identities crossed: ${isolatedIdentities}`,
    );
    await isolated.close();
    isolated = undefined;

    const consoleEvent = shared.first.page.waitForEvent("console", {
      predicate: (message) => message.type() === "error",
    });
    await shared.first.page.evaluate(() => console.error("token=literal-secret"));
    await consoleEvent;
    const pageError = shared.first.page.waitForEvent("pageerror");
    await shared.first.page.evaluate(() => {
      queueMicrotask(() => {
        throw new Error("secret=literal-secret");
      });
    });
    await pageError;
    const requestFailed = shared.first.page.waitForEvent("requestfailed");
    await shared.first.page.evaluate(() =>
      fetch("http://127.0.0.1:1/private?token=literal-secret").catch(() => undefined)
    );
    await requestFailed;

    const captured = await shared.captureFailure(
      "integration failure",
      (client) => Promise.resolve({ online: !client.offline, itemCount: 0 }),
    );
    assert(captured, "failure artifacts were not created");
    assert(captured.files.some((path) => path.endsWith(".png")), "screenshots were omitted");
    assert(
      captured.files.filter((path) => path.endsWith(".trace.zip")).length === 2,
      "one trace per client was not retained",
    );
    assert(
      captured.files.every((path) => !path.toLowerCase().includes("storage")),
      `storage state leaked into artifact names: ${captured.files}`,
    );
    const diagnostics = await Deno.readTextFile(`${captured.directory}/diagnostics.json`);
    assert(!diagnostics.includes("literal-secret"), diagnostics);
    assert(diagnostics.includes("[redacted]"), diagnostics);
    for (const tracePath of captured.files.filter((path) => path.endsWith(".trace.zip"))) {
      const entries = await readTraceArchive(tracePath);
      for (const bytes of Object.values(entries)) {
        assert(
          !new TextDecoder().decode(bytes).includes("literal-secret"),
          `${tracePath} retained a secret`,
        );
      }
    }

    const browser = shared.browser;
    await shared.close();
    shared = undefined;
    assert(!browser.isConnected(), "owned Chromium process remained connected after close");
  } finally {
    await isolated?.close().catch(() => undefined);
    await shared?.close().catch(() => undefined);
    await server.shutdown().catch(() => undefined);
    await Deno.remove(artifacts, { recursive: true });
  }
});
