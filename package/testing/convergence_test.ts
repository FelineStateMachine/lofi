import {
  ConvergenceScenarioError,
  type OfflineTestClient,
  type OfflineTestFixture,
  runConcurrentOfflineConvergence,
} from "./convergence.ts";
import type { ValueFreeState } from "./safety.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class FakeClient implements OfflineTestClient {
  offline = false;
  readonly events: string[] = [];

  constructor(readonly name: string) {}

  goOffline(): Promise<void> {
    this.offline = true;
    this.events.push("offline");
    return Promise.resolve();
  }

  goOnline(): Promise<void> {
    this.offline = false;
    this.events.push("online");
    return Promise.resolve();
  }
}

class FakeFixture implements OfflineTestFixture<FakeClient> {
  readonly first = new FakeClient("first");
  readonly second = new FakeClient("second");
  readonly clients = [this.first, this.second] as const;
  captures: Array<{ label: string; states?: ValueFreeState[] }> = [];

  async goOffline(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.goOffline()));
  }

  async goOnline(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.goOnline()));
  }

  async captureFailure(
    label: string,
    snapshot?: (client: FakeClient) => Promise<ValueFreeState>,
  ): Promise<void> {
    this.captures.push({
      label,
      states: snapshot ? await Promise.all(this.clients.map(snapshot)) : undefined,
    });
  }
}

Deno.test("offline convergence starts edits concurrently and leaves both clients online", async () => {
  const fixture = new FakeFixture();
  const entered: string[] = [];
  let release!: () => void;
  const bothEntered = new Promise<void>((resolve) => (release = resolve));

  await runConcurrentOfflineConvergence(fixture, {
    edits: ["alpha", "beta"],
    ready: () => Promise.resolve(),
    async apply(client, edit) {
      assert(client.offline, `${client.name} edit ran online`);
      entered.push(`${client.name}:${edit}`);
      if (entered.length === 2) release();
      await bothEntered;
    },
    locallyApplied: () => Promise.resolve(),
    whilePending(current) {
      assert(current.clients.every((client) => client.offline), "pending hook ran online");
      return Promise.resolve();
    },
    converged(current) {
      assert(current.clients.every((client) => !client.offline), "convergence ran offline");
      return Promise.resolve();
    },
  });

  assert(entered.join(",") === "first:alpha,second:beta", `edits were not paired: ${entered}`);
  assert(fixture.clients.every((client) => !client.offline), "clients were left offline");
  assert(fixture.captures.length === 0, "successful scenario captured failure artifacts");
});

Deno.test("offline convergence captures the failing stage and restores connectivity", async () => {
  const fixture = new FakeFixture();
  try {
    await runConcurrentOfflineConvergence(fixture, {
      edits: [1, 2],
      ready: () => Promise.resolve(),
      apply: () => Promise.reject(new Error("edit failed")),
      locallyApplied: () => Promise.resolve(),
      converged: () => Promise.resolve(),
      snapshot: (client) => Promise.resolve({ offline: client.offline }),
    });
    throw new Error("expected scenario failure");
  } catch (error) {
    assert(error instanceof ConvergenceScenarioError, `unexpected error: ${error}`);
    assert(error.stage === "concurrent edits", `unexpected stage: ${error.stage}`);
  }
  assert(fixture.clients.every((client) => !client.offline), "failure left clients offline");
  assert(fixture.captures.length === 1, "failure artifacts were not requested once");
  assert(
    fixture.captures[0].label.includes("concurrent edits"),
    `failure label lost the stage: ${fixture.captures[0].label}`,
  );
});

Deno.test("offline convergence bounds a never-settling app predicate", async () => {
  const fixture = new FakeFixture();
  try {
    await runConcurrentOfflineConvergence(fixture, {
      edits: [1, 2],
      timeoutMs: 10,
      ready: () => Promise.resolve(),
      apply: () => Promise.resolve(),
      locallyApplied: () => Promise.resolve(),
      converged: () => new Promise(() => undefined),
    });
    throw new Error("expected convergence deadline failure");
  } catch (error) {
    assert(error instanceof ConvergenceScenarioError, `unexpected error: ${error}`);
    assert(error.stage === "convergence", `unexpected stage: ${error.stage}`);
    assert(
      error.cause instanceof Error && error.cause.message.includes("10ms deadline"),
      `deadline cause was not retained: ${error.cause}`,
    );
  }
  assert(fixture.clients.every((client) => !client.offline), "deadline left clients offline");
});
