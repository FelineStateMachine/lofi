export type ForegroundRecoveryReason = "pageshow" | "visibilitychange" | "online";

export type ForegroundRecoveryState = {
  mode: "local-only" | "managed";
  status: "idle" | "offline-deferred" | "recovering" | "completed" | "failed";
  attempts: number;
  lastReason: ForegroundRecoveryReason | "none";
};

export type ForegroundRecovery = {
  getState(): ForegroundRecoveryState;
  subscribe(listener: () => void): () => void;
  request(reason: ForegroundRecoveryReason): Promise<void>;
  dispose(): void;
};

export function createForegroundRecovery(options: {
  enabled: boolean;
  pageTarget: EventTarget;
  visibilityTarget: EventTarget;
  isVisible(): boolean;
  isOnline(): boolean;
  reconnect(): Promise<void>;
}): ForegroundRecovery {
  let active = true;
  let recovery: Promise<void> | null = null;
  let state: ForegroundRecoveryState = {
    mode: options.enabled ? "managed" : "local-only",
    status: "idle",
    attempts: 0,
    lastReason: "none",
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ForegroundRecoveryState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const request = (reason: ForegroundRecoveryReason): Promise<void> => {
    if (!active || !options.enabled) return Promise.resolve();
    if (reason !== "online" && !options.isOnline()) {
      publish({ status: "offline-deferred", lastReason: reason });
      return Promise.resolve();
    }
    if (recovery) return recovery;
    publish({ status: "recovering", attempts: state.attempts + 1, lastReason: reason });
    const operation = options.reconnect().then(
      () => publish({ status: "completed" }),
      (error) => {
        publish({ status: "failed" });
        throw error;
      },
    );
    const tracked = operation.finally(() => {
      if (recovery === tracked) recovery = null;
    });
    recovery = tracked;
    return tracked;
  };
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted === true) void request("pageshow");
  };
  const onVisibilityChange = () => {
    if (options.isVisible()) void request("visibilitychange");
  };
  const onOnline = () => void request("online");
  if (options.enabled) {
    options.pageTarget.addEventListener("pageshow", onPageShow);
    options.pageTarget.addEventListener("online", onOnline);
    options.visibilityTarget.addEventListener("visibilitychange", onVisibilityChange);
  }
  return {
    getState: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request,
    dispose() {
      if (!active) return;
      active = false;
      listeners.clear();
      options.pageTarget.removeEventListener("pageshow", onPageShow);
      options.pageTarget.removeEventListener("online", onOnline);
      options.visibilityTarget.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
