// The fixture module value-loads Playwright, which touches system APIs at
// import time; it is loaded lazily inside the run path so declaring (and
// skipping) a browser scenario never pays that cost.
import type { Page } from "playwright";
import type {
  BrowserTestClient,
  FailureArtifactOptions,
  IdentityOptions,
  TwoClientFixture,
} from "../fixture.ts";
import type { ValueFreeState } from "../safety.ts";
import { ScenarioError, type ScenarioStage } from "./errors.ts";
import { registerConvergeSource, type ScenarioPeerControls } from "./peer.ts";

/**
 * A browser scenario peer: the scenario controls over a real browser client.
 * There is no typed `db` here — the app's data lives inside the page, so
 * edits go through the page and state is observed through the scenario's
 * value-free snapshot hook.
 */
export interface BrowserScenarioPeer extends ScenarioPeerControls {
  /** The underlying browser client, for artifacts and diagnostics. */
  readonly client: BrowserTestClient;
  /** The peer's page, for page-mediated edits and assertions. */
  readonly page: Page;
}

/** The peers a browser scenario body receives. */
export interface BrowserScenarioContext {
  /** The first peer — the primary identity when identity mode is `shared`. */
  readonly alice: BrowserScenarioPeer;
  /** The second peer. */
  readonly bob: BrowserScenarioPeer;
}

/** Configuration for a browser scenario. */
export interface BrowserScenarioOptions {
  /**
   * The served app under test. When `undefined` the scenario logs a skip
   * notice and passes, so browser scenarios stay opt-in — the conventional
   * source is the `LOFI_E2E_BASE_URL` environment variable.
   */
  baseURL: string | undefined;
  /** Identity mode for the two clients, forwarded to the two-client fixture. */
  identity: IdentityOptions;
  /** App-owned readiness assertion, awaited on both peers before the body runs. */
  ready: (peer: BrowserScenarioPeer) => Promise<void>;
  /**
   * App-owned, value-free view of the peer's state — counts and booleans,
   * never user data. Convergence and settling compare these snapshots, and a
   * failure's artifacts include them.
   */
  snapshot: (peer: BrowserScenarioPeer) => Promise<ValueFreeState>;
  /** Failure artifact capture options, forwarded to the two-client fixture. */
  artifacts?: FailureArtifactOptions;
  /** Overall defensive deadline for the whole scenario. Defaults to 120 seconds. */
  timeoutMs?: number;
}

const SNAPSHOT_POLL_MS = 250;

function makePeer(
  name: string,
  client: BrowserTestClient,
  snapshot: (peer: BrowserScenarioPeer) => Promise<ValueFreeState>,
): BrowserScenarioPeer {
  const peer: BrowserScenarioPeer = {
    name,
    client,
    get page() {
      return client.page;
    },
    get isOffline() {
      return client.offline;
    },
    async offline() {
      await client.goOffline();
    },
    async online() {
      await client.goOnline();
    },
    async settle(options) {
      const timeoutMs = options?.timeoutMs ?? 20_000;
      const deadline = Date.now() + timeoutMs;
      let previous: string | undefined;
      while (Date.now() < deadline) {
        const current = JSON.stringify(await snapshot(peer));
        if (previous !== undefined && current === previous) return;
        previous = current;
        await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_POLL_MS));
      }
      throw new ScenarioError(
        "convergence",
        `${name}'s snapshot did not stabilize within ${timeoutMs}ms`,
        { peer: name },
      );
    },
  };
  registerConvergeSource(peer, { kind: "snapshot", snapshot: () => snapshot(peer) });
  return peer;
}

/**
 * The browser scenario core: boots the two-client fixture against the served
 * app, readies both peers, runs the body, and captures value-free failure
 * artifacts before tearing down. Skips (resolving cleanly, with a notice)
 * when no `baseURL` is configured or no browser is installed.
 */
export async function runBrowserScenario(
  options: BrowserScenarioOptions,
  body: (context: BrowserScenarioContext) => Promise<void>,
): Promise<void> {
  if (!options.baseURL) {
    console.log("skipping browser scenario; set LOFI_E2E_BASE_URL to a served app to run it");
    return;
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("scenario timeoutMs must be a positive finite number");
  }

  const { BrowserUnavailableError, createTwoClientFixture } = await import("../fixture.ts");
  let fixture: TwoClientFixture;
  try {
    fixture = await createTwoClientFixture({
      baseURL: options.baseURL,
      identity: options.identity,
      artifacts: options.artifacts,
    });
  } catch (error) {
    if (error instanceof BrowserUnavailableError) {
      console.log(error.message);
      return;
    }
    throw new ScenarioError("boot", "browser fixture creation failed", { cause: error });
  }

  const alice = makePeer("alice", fixture.first, options.snapshot);
  const bob = makePeer("bob", fixture.second, options.snapshot);
  const peers = [alice, bob];
  const deadline = setTimeout(() => {
    // The deadline is defensive: close() interrupts a hung page wait.
    void fixture.close().catch(() => undefined);
  }, timeoutMs);

  let stage: ScenarioStage = "peers";
  try {
    await Promise.all(peers.map((peer) => options.ready(peer)));
    stage = "body";
    await body({ alice, bob });
  } catch (error) {
    if (error instanceof ScenarioError) throw error;
    let captureError: unknown;
    try {
      await fixture.captureFailure(
        `scenario-${stage}`,
        (client) => options.snapshot(client === fixture.first ? alice : bob),
      );
    } catch (failure) {
      captureError = failure ?? new Error("failure-artifact capture rejected without a reason");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ScenarioError(stage, message, {
      cause: error,
      details: captureError !== undefined
        ? "failure-artifact capture also failed (see cause chain)"
        : undefined,
    });
  } finally {
    clearTimeout(deadline);
    await Promise.allSettled(
      peers.filter((peer) => peer.isOffline).map((peer) => peer.online()),
    );
    await fixture.close();
  }
}
