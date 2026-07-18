import { activeServerUrl, syncing } from "./config.ts";
// Package-owned browser lifecycle.
import { createForegroundRecovery, type ForegroundRecoveryState } from "./foreground-recovery.ts";
import { getRuntime } from "./runtime.ts";
import { isTransportPausedByInspector } from "./transport-gate.ts";

// Evaluated at document load: declaring a sink reloads the document on the
// SharedWorker path (see `session.ts`), so recovery activates on the boot that
// first has a sync location.
const recovery = typeof document === "undefined" ? null : createForegroundRecovery({
  enabled: Boolean(activeServerUrl()),
  pageTarget: globalThis,
  visibilityTarget: document,
  isVisible: () => document.visibilityState === "visible",
  isOnline: () => navigator.onLine,
  // Reconnect only while the user's election stands and the inspector has not
  // paused the transport — a configured server alone is not consent.
  shouldReconnect: () => syncing() && !isTransportPausedByInspector(),
  reconnect: async () => {
    const runtime = await getRuntime();
    await runtime.db.reconnect();
  },
});

export function getForegroundRecoveryState(): ForegroundRecoveryState {
  return recovery?.getState() ?? {
    mode: activeServerUrl() ? "managed" : "local-only",
    status: "idle",
    attempts: 0,
    lastReason: "none",
  };
}

export function subscribeForegroundRecovery(listener: () => void): () => void {
  return recovery?.subscribe(listener) ?? (() => undefined);
}

import.meta.hot?.dispose(() => recovery?.dispose());
