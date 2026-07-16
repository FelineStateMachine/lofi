import { serverUrl } from "./config.ts";
import { createForegroundRecovery, type ForegroundRecoveryState } from "./foreground-recovery.ts";
import { getRuntime } from "./runtime.ts";

const recovery = typeof document === "undefined" ? null : createForegroundRecovery({
  enabled: Boolean(serverUrl),
  pageTarget: globalThis,
  visibilityTarget: document,
  isVisible: () => document.visibilityState === "visible",
  isOnline: () => navigator.onLine,
  reconnect: async () => {
    const runtime = await getRuntime();
    await runtime.db.reconnect();
  },
});

export function getForegroundRecoveryState(): ForegroundRecoveryState {
  return recovery?.getState() ?? {
    mode: serverUrl ? "managed" : "local-only",
    status: "idle",
    attempts: 0,
    lastReason: "none",
  };
}

export function subscribeForegroundRecovery(listener: () => void): () => void {
  return recovery?.subscribe(listener) ?? (() => undefined);
}

import.meta.hot?.dispose(() => recovery?.dispose());
