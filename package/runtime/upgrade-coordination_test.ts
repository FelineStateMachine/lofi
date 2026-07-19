import {
  createUpgradeCoordinator,
  type UpgradeChannel,
  upgradeChannelName,
  type UpgradeCoordinatorOptions,
  type UpgradeLockManager,
  upgradeLockName,
} from "./upgrade-coordination.ts";
import { assert } from "./test-assert.ts";

// A shared in-memory BroadcastChannel bus: every coordinator built over one
// bus behaves like a tab on the same origin and scope.
class FakeChannelBus {
  readonly channels = new Map<string, Set<FakeChannel>>();

  open(name: string): FakeChannel {
    const channel = new FakeChannel(this, name);
    let peers = this.channels.get(name);
    if (!peers) {
      peers = new Set();
      this.channels.set(name, peers);
    }
    peers.add(channel);
    return channel;
  }

  broadcast(from: FakeChannel, name: string, message: unknown): void {
    for (const peer of this.channels.get(name) ?? []) {
      // BroadcastChannel never delivers to the posting port.
      if (peer !== from) peer.deliver(message);
    }
  }
}

class FakeChannel implements UpgradeChannel {
  readonly #listeners = new Set<(event: MessageEvent) => void>();
  constructor(private readonly bus: FakeChannelBus, private readonly name: string) {}
  postMessage(message: unknown): void {
    this.bus.broadcast(this, this.name, message);
  }
  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.#listeners.add(listener);
  }
  deliver(message: unknown): void {
    for (const listener of this.#listeners) {
      listener({ data: message } as MessageEvent);
    }
  }
  close(): void {
    this.#listeners.clear();
    this.bus.channels.get(this.name)?.delete(this);
  }
}

// A minimal Web Locks implementation: shared requests coexist, an exclusive
// request waits for every earlier holder, and later requests queue behind a
// pending exclusive one — the semantics the quiescence handshake relies on.
type LockRequest = {
  mode: "shared" | "exclusive";
  grant: () => void;
};

class FakeLockManager implements UpgradeLockManager {
  readonly #queues = new Map<string, { holders: LockRequest[]; queue: LockRequest[] }>();

  request<T>(
    name: string,
    options: { mode: "shared" | "exclusive" },
    callback: (lock: unknown) => Promise<T> | T,
  ): Promise<T> {
    let state = this.#queues.get(name);
    if (!state) {
      state = { holders: [], queue: [] };
      this.#queues.set(name, state);
    }
    const lockState = state;
    return new Promise<T>((resolve, reject) => {
      const request: LockRequest = {
        mode: options.mode,
        grant: () => {
          lockState.holders.push(request);
          void Promise.resolve()
            .then(() => callback({}))
            .then(resolve, reject)
            .finally(() => {
              lockState.holders.splice(lockState.holders.indexOf(request), 1);
              this.#drain(lockState);
            });
        },
      };
      lockState.queue.push(request);
      this.#drain(lockState);
    });
  }

  #drain(state: { holders: LockRequest[]; queue: LockRequest[] }): void {
    while (state.queue.length > 0) {
      const next = state.queue[0];
      if (next.mode === "exclusive") {
        if (state.holders.length > 0) return;
        state.queue.shift();
        next.grant();
        return;
      }
      if (state.holders.some((holder) => holder.mode === "exclusive")) return;
      state.queue.shift();
      next.grant();
    }
  }
}

function tab(
  bus: FakeChannelBus,
  locks: FakeLockManager,
  overrides: Partial<UpgradeCoordinatorOptions> = {},
) {
  return createUpgradeCoordinator({
    scopePath: "/app/",
    channel: (name) => bus.open(name),
    locks: () => locks,
    ...overrides,
  });
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

Deno.test("channel and lock names are scope-keyed like the worker's cache names", () => {
  assert(
    upgradeChannelName("/field-notes/") === "lofi-scope-field-notes-upgrade",
    "channel name is not scope-keyed",
  );
  assert(
    upgradeLockName("/field-notes/") === "lofi-scope-field-notes-writes",
    "lock name is not scope-keyed",
  );
  assert(upgradeChannelName("/") === "lofi-scope-root-upgrade", "root scope key drifted");
});

Deno.test("two tabs: the swap waits for the sibling's in-flight write to settle", async () => {
  const bus = new FakeChannelBus();
  const locks = new FakeLockManager();
  const initiating = tab(bus, locks);
  const sibling = tab(bus, locks);
  try {
    // The sibling has a write in flight (its shared lock is held).
    const releaseWrite = await sibling.acquireWriteLock();
    let swapped = false;
    const announce = initiating.announceUpgrade().then(() => swapped = true);
    await flush();
    assert(sibling.writesPaused(), "the sibling did not pause writes on the announcement");
    assert(initiating.writesPaused(), "the initiating tab did not pause its own writes");
    assert(!swapped, "the swap proceeded while a write was in flight");
    releaseWrite();
    await announce;
    assert(swapped, "the swap did not proceed once writes settled");
  } finally {
    initiating.dispose();
    sibling.dispose();
  }
});

Deno.test("two tabs: writes queued during the swap window resume after activation", async () => {
  const bus = new FakeChannelBus();
  const locks = new FakeLockManager();
  const initiating = tab(bus, locks);
  const sibling = tab(bus, locks);
  try {
    await initiating.announceUpgrade();
    let acquired = false;
    const write = sibling.acquireWriteLock().then((release) => {
      acquired = true;
      return release;
    });
    await flush();
    assert(!acquired, "a paused sibling accepted a new write during the swap window");
    // Activation reached the sibling (controllerchange); its window ends.
    sibling.notifyActivation();
    (await write)();
    assert(acquired, "the sibling's queued write did not resume after activation");
  } finally {
    initiating.dispose();
    sibling.dispose();
  }
});

Deno.test("an abandoned swap window resumes writes at the bounded timeout", async () => {
  const bus = new FakeChannelBus();
  const locks = new FakeLockManager();
  const timers: Array<() => void> = [];
  const sibling = tab(bus, locks, {
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  const initiating = tab(bus, locks);
  try {
    await initiating.announceUpgrade();
    assert(sibling.writesPaused(), "the sibling did not pause writes");
    // The worker swap never happens; the pause-window timer expires.
    for (const expire of timers.splice(0)) expire();
    assert(!sibling.writesPaused(), "the pause window did not expire");
    (await sibling.acquireWriteLock())();
  } finally {
    initiating.dispose();
    sibling.dispose();
  }
});

Deno.test("quiescence is bounded when a shared holder never settles", async () => {
  const bus = new FakeChannelBus();
  const locks = new FakeLockManager();
  const timers: Array<() => void> = [];
  const initiating = tab(bus, locks, {
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  const sibling = tab(bus, locks);
  try {
    await sibling.acquireWriteLock(); // never released
    let swapped = false;
    const announce = initiating.announceUpgrade().then(() => swapped = true);
    await flush();
    assert(!swapped, "the swap did not wait at all");
    for (const expire of timers.splice(0)) expire();
    await announce;
    assert(swapped, "a hung write blocked the swap past its bound");
  } finally {
    initiating.dispose();
    sibling.dispose();
  }
});

Deno.test("without Web Locks and BroadcastChannel the coordinator degrades safely", async () => {
  const coordinator = createUpgradeCoordinator({
    scopePath: "/app/",
    channel: () => undefined,
    locks: () => undefined,
  });
  try {
    (await coordinator.acquireWriteLock())();
    await coordinator.announceUpgrade();
    assert(coordinator.writesPaused(), "the local pause window is still expected");
    coordinator.notifyActivation();
    assert(!coordinator.writesPaused(), "activation did not end the local pause");
  } finally {
    coordinator.dispose();
  }
});
