import {
  type BrowserScenarioContext,
  type BrowserScenarioOptions,
  runBrowserScenario,
} from "./browser.ts";
import { type FuzzScenarioOptions, runFuzzScenario } from "./fuzz.ts";
import type { ScenarioApp } from "./headless.ts";
import { runHeadlessScenario, type ScenarioConfig, type ScenarioContext } from "./run.ts";

/**
 * The scenario entry points. The call signature registers a headless
 * scenario; {@link ScenarioApi.fuzz} and {@link ScenarioApi.browser} register
 * the fuzz and browser flavors. Each call registers one `Deno.test`, so
 * scenarios are declared at the top level of a test module.
 */
export interface ScenarioApi {
  /**
   * Declare a headless scenario: two peers (alice and bob) on real synced
   * clients against a local sync server, driving the app's own tables.
   */
  <A extends ScenarioApp>(
    name: string,
    config: ScenarioConfig<A>,
    body: (context: ScenarioContext<A>) => Promise<void>,
  ): void;
  /**
   * Declare a fuzz scenario: a seeded, replayable operation sequence across
   * both peers, checked for convergence — including against a fresh reader.
   */
  fuzz<A extends ScenarioApp>(name: string, options: FuzzScenarioOptions<A>): void;
  /**
   * Declare a browser scenario: two Playwright clients against a served app,
   * with page-mediated edits and value-free snapshots. Skips cleanly when no
   * `baseURL` is configured or no browser is installed.
   */
  browser(
    name: string,
    options: BrowserScenarioOptions,
    body: (context: BrowserScenarioContext) => Promise<void>,
  ): void;
}

/**
 * Declare simulation-test scenarios: named peers make concurrent and offline
 * edits through the app's own schema, and the test asserts they converge.
 *
 * ```ts
 * scenario("offline rename vs remote delete", { app, permissions }, async ({ alice, bob }) => {
 *   const doc = await alice.db.documents.insert({ title: "Untitled" });
 *   await converge(alice, bob);
 *
 *   await alice.offline();
 *   await alice.db.documents.update(doc.id, { title: "Draft" });
 *   await bob.db.documents.remove(doc.id);
 *   await alice.online();
 *   await alice.settle();
 *
 *   await alice.restart(); // the live writer keeps its doomed rename until it restarts
 *   await converge(alice, bob);
 *   await assertNoRow(alice, app.documents, doc.id);
 * });
 * ```
 */
export const scenario: ScenarioApi = Object.assign(
  function scenario<A extends ScenarioApp>(
    name: string,
    config: ScenarioConfig<A>,
    body: (context: ScenarioContext<A>) => Promise<void>,
  ): void {
    Deno.test(name, () => runHeadlessScenario(config, body));
  },
  {
    fuzz<A extends ScenarioApp>(name: string, options: FuzzScenarioOptions<A>): void {
      Deno.test(name, () => runFuzzScenario(options));
    },
    browser(
      name: string,
      options: BrowserScenarioOptions,
      body: (context: BrowserScenarioContext) => Promise<void>,
    ): void {
      Deno.test(name, () => runBrowserScenario(options, body));
    },
  },
);
