/**
 * Cross-tab coordination for the service-worker swap.
 *
 * Two tabs on the same scope share one store, so an `applyUpdate()` in one
 * tab must not race writes in another. The coordinator announces upgrade
 * intent on a scope-keyed BroadcastChannel, every tab pauses new local writes
 * for the swap window, and a scope-keyed Web Lock — held shared for the
 * duration of each local write — lets the announcing tab wait for in-flight
 * writes to settle (an exclusive acquisition) before the worker swap. Channel
 * and lock names carry the registration scope exactly like the service
 * worker's cache names, so sibling lofi apps on one origin never cross-talk.
 *
 * Every browser surface is feature-detected: without BroadcastChannel or Web
 * Locks the coordinator degrades to local-only pausing, and the swap still
 * proceeds after a bounded quiescence timeout.
 *
 * Internal module: not part of the package export map. Applications reach
 * this behavior through `applyUpdate()` and the `pwa` application config.
 *
 * @module
 */

/** Minimal BroadcastChannel surface, injectable for tests. */
export type UpgradeChannel = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
};

/** Minimal Web Locks surface, injectable for tests. */
export type UpgradeLockManager = {
  request<T>(
    name: string,
    options: { mode: "shared" | "exclusive" },
    callback: (lock: unknown) => Promise<T> | T,
  ): Promise<T>;
};

/** Derives the scope key used in channel and lock names from a scope path. */
export function upgradeScopeKey(scopePath: string): string {
  return scopePath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

/** The BroadcastChannel name for one scope's upgrade announcements. */
export function upgradeChannelName(scopePath: string): string {
  return `lofi-scope-${upgradeScopeKey(scopePath)}-upgrade`;
}

/** The Web Lock name held shared by local writes on one scope. */
export function upgradeLockName(scopePath: string): string {
  return `lofi-scope-${upgradeScopeKey(scopePath)}-writes`;
}

/** Injectable surfaces and bounds for one upgrade coordinator. */
export type UpgradeCoordinatorOptions = {
  /** The service-worker registration scope path (e.g. `/app/`). */
  scopePath: string;
  /** Channel factory; defaults to the browser BroadcastChannel when present. */
  channel?: (name: string) => UpgradeChannel | undefined;
  /** Lock manager; defaults to `navigator.locks` when present. */
  locks?: () => UpgradeLockManager | undefined;
  /** How long tabs pause writes waiting for the swap; defaults to 15 seconds. */
  pauseWindowMs?: number;
  /** How long the announcer waits for in-flight writes; defaults to 5 seconds. */
  quiescenceTimeoutMs?: number;
  readonly setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
};

/** Coordinates one tab's participation in a scope-wide worker swap. */
export type UpgradeCoordinator = {
  /**
   * Announces upgrade intent to every tab on the scope (this one included)
   * and resolves once in-flight local writes have settled or the bounded
   * quiescence window expired — the safe moment to swap the worker.
   */
  announceUpgrade(): Promise<void>;
  /**
   * Acquires the shared write lock for one local write, waiting out any
   * announced swap window first. The returned function releases the hold and
   * is safe to call more than once.
   */
  acquireWriteLock(): Promise<() => void>;
  /** Ends this tab's pause window after the swap completed or was abandoned. */
  notifyActivation(): void;
  /** Whether writes are currently paused for an announced swap. */
  writesPaused(): boolean;
  /** Closes the channel and releases timers. */
  dispose(): void;
};

const upgradeIntentMessage = { type: "lofi-upgrade-intent" } as const;

/** Creates an isolated coordinator; production wiring uses the shared one. */
export function createUpgradeCoordinator(options: UpgradeCoordinatorOptions): UpgradeCoordinator {
  const pauseWindowMs = options.pauseWindowMs ?? 15_000;
  const quiescenceTimeoutMs = options.quiescenceTimeoutMs ?? 5_000;
  const scheduleTimeout = (callback: () => void, milliseconds: number) =>
    options.setTimeout ? options.setTimeout(callback, milliseconds) : (
      globalThis.setTimeout(callback, milliseconds)
    );
  const cancelTimeout = (handle: unknown) => {
    if (options.clearTimeout) options.clearTimeout(handle);
    else globalThis.clearTimeout(handle as number);
  };
  const locks = () =>
    options.locks
      ? options.locks()
      : (typeof navigator !== "undefined" && "locks" in navigator
        ? (navigator as { locks: UpgradeLockManager }).locks
        : undefined);
  const openChannel = (name: string): UpgradeChannel | undefined => {
    if (options.channel) return options.channel(name);
    return typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(name);
  };

  const lockName = upgradeLockName(options.scopePath);
  let paused = false;
  let pauseTimer: unknown;
  const resumeWaiters = new Set<() => void>();
  let disposed = false;

  const resume = () => {
    if (!paused) return;
    paused = false;
    if (pauseTimer !== undefined) cancelTimeout(pauseTimer);
    pauseTimer = undefined;
    for (const waiter of resumeWaiters) waiter();
    resumeWaiters.clear();
  };

  // The pause window is bounded: a swap that never completes (the waiting
  // worker failed, the announcing tab closed) must not leave every sibling
  // tab refusing writes forever.
  const pause = () => {
    if (paused || disposed) return;
    paused = true;
    if (pauseTimer !== undefined) cancelTimeout(pauseTimer);
    pauseTimer = scheduleTimeout(resume, pauseWindowMs);
  };

  const channel = openChannel(upgradeChannelName(options.scopePath));
  channel?.addEventListener("message", (event) => {
    const message = event.data as { type?: string } | undefined;
    if (message?.type === upgradeIntentMessage.type) pause();
  });

  const waitWhilePaused = (): Promise<void> => {
    if (!paused) return Promise.resolve();
    return new Promise((resolve) => resumeWaiters.add(resolve));
  };

  const acquireQuiescence = (): Promise<void> => {
    const manager = locks();
    if (!manager) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        return true;
      };
      const timer = scheduleTimeout(() => {
        if (finish()) resolve();
      }, quiescenceTimeoutMs);
      // Acquiring the exclusive lock resolves only once every shared holder
      // (an in-flight local write) released; the lock is dropped immediately
      // — quiescence is a moment, not a held state.
      void Promise.resolve(manager.request(lockName, { mode: "exclusive" }, () => undefined))
        .catch(() => undefined)
        .then(() => {
          cancelTimeout(timer);
          if (finish()) resolve();
        });
    });
  };

  return {
    async announceUpgrade() {
      channel?.postMessage(upgradeIntentMessage);
      pause();
      await acquireQuiescence();
    },
    async acquireWriteLock() {
      await waitWhilePaused();
      const manager = locks();
      if (!manager) return () => undefined;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Wait for the acquisition itself: a write must not proceed while an
      // announced swap holds (or is queued for) the exclusive lock.
      await new Promise<void>((resolve) => {
        void Promise.resolve(manager.request(lockName, { mode: "shared" }, () => {
          resolve();
          return held;
        })).catch(() => resolve());
      });
      return release;
    },
    notifyActivation: resume,
    writesPaused: () => paused,
    dispose() {
      disposed = true;
      resume();
      channel?.close();
    },
  };
}

let shared: UpgradeCoordinator | null = null;

/**
 * Configures the shared coordinator for the registration scope in effect.
 * Called by the boot wiring once the deployment scope is known; repeated
 * calls replace the previous coordinator.
 */
export function configureUpgradeCoordinator(scopePath: string): UpgradeCoordinator {
  shared?.dispose();
  shared = createUpgradeCoordinator({ scopePath });
  return shared;
}

/** The shared coordinator, or `null` before boot wiring configured one. */
export function sharedUpgradeCoordinator(): UpgradeCoordinator | null {
  return shared;
}

/**
 * Acquires the shared write lock for one local write through the shared
 * coordinator; a no-op release when no coordinator is configured.
 */
export function acquireUpgradeWriteLock(): Promise<() => void> {
  return shared ? shared.acquireWriteLock() : Promise.resolve(() => undefined);
}
