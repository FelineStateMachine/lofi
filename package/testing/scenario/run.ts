import type { CompiledPermissions } from "jazz-tools";
import { ScenarioError, type ScenarioStage } from "./errors.ts";
import { createHeadlessScenarioHarness, type ScenarioApp } from "./headless.ts";
import type { ScenarioPeer } from "./peer.ts";

/** The app under test plus the scenario's own settings. */
export interface ScenarioConfig<A extends ScenarioApp> {
  /** The app object, as returned by `s.defineApp`. */
  app: A;
  /** The compiled permission bundle, as returned by `s.definePermissions`. */
  permissions: CompiledPermissions;
  /** Overall defensive deadline for the whole scenario. Defaults to 60 seconds. */
  timeoutMs?: number;
}

/** The peers a scenario body receives, plus a factory for additional ones. */
export interface ScenarioContext<A> {
  /** The first peer, online and synced at scenario start. */
  readonly alice: ScenarioPeer<A>;
  /** The second peer, online and synced at scenario start. */
  readonly bob: ScenarioPeer<A>;
  /**
   * Boot another named peer — e.g. a fresh reader that joins after the edits
   * to observe the server-canonical state.
   */
  addPeer(name: string): Promise<ScenarioPeer<A>>;
}

/**
 * The headless scenario core: boots a local sync server, deploys the app,
 * creates the alice and bob peers, runs the body, and tears everything down
 * with bounded waits. Thrown failures are wrapped in {@link ScenarioError}
 * naming the lifecycle stage that failed.
 */
export async function runHeadlessScenario<A extends ScenarioApp>(
  config: ScenarioConfig<A>,
  body: (context: ScenarioContext<A>) => Promise<void>,
): Promise<void> {
  const timeoutMs = config.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("scenario timeoutMs must be a positive finite number");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`scenario exceeded its ${timeoutMs}ms deadline`)),
    timeoutMs,
  );
  const withinDeadline = async <Result>(operation: Promise<Result>): Promise<Result> => {
    if (controller.signal.aborted) throw controller.signal.reason;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
  };

  let stage: ScenarioStage = "boot";
  const peers: ScenarioPeer<A>[] = [];
  let harness: Awaited<ReturnType<typeof createHeadlessScenarioHarness<A>>> | undefined;
  try {
    harness = await withinDeadline(
      createHeadlessScenarioHarness(config.app, config.permissions),
    );
    stage = "peers";
    const booted = harness;
    const addPeer = async (name: string): Promise<ScenarioPeer<A>> => {
      const peer = await withinDeadline(booted.peer(name));
      peers.push(peer);
      return peer;
    };
    const alice = await addPeer("alice");
    const bob = await addPeer("bob");
    stage = "body";
    await withinDeadline(body({ alice, bob, addPeer }));
  } catch (error) {
    if (error instanceof ScenarioError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ScenarioError(stage, message, { cause: error });
  } finally {
    clearTimeout(timeout);
    await Promise.allSettled(
      peers.filter((peer) => peer.isOffline).map((peer) => peer.online()),
    );
    if (harness !== undefined) await harness.stop();
  }
}
