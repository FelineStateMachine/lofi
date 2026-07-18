/**
 * Package-owned durable-write settlement.
 *
 * One implementation of the local→global settlement ladder and its
 * diagnostics accounting — pending counters, wait counts, and mutation-error
 * counts — previously triplicated across table stores, mutation stores, and
 * access operations (where drift left access writes invisible to the
 * inspector). Snapshot state such as durability labels, error text, and
 * write-generation guards stays caller-owned through hooks.
 *
 * @module
 */

import type { RuntimeDiagnostics } from "./diagnostics.ts";

/** A vendor write handle that can await local and global durability tiers. */
export type DurableWrite<T> = {
  wait(options: { tier: "local" | "global" }): Promise<T>;
};

/**
 * How the global tier is handled once local durability settles: not at all
 * (`none`, sync unconfigured), tracked without blocking the caller
 * (`background`, UI stores), or awaited inline (`await`, access operations).
 */
export type GlobalTierMode = "none" | "background" | "await";

/** Caller hooks projecting settlement outcomes into caller-owned state. */
export type SettlementHooks = {
  /** Runs after local durability settles, before any global handling. */
  onLocal?: () => void;
  /** Runs when the global tier settles successfully. */
  onGlobal?: () => void;
  /** Runs when the global tier rejects; the rejection is already counted. */
  onGlobalError?: (error: unknown) => void;
};

/**
 * Settles one durable write with shared diagnostics accounting. Resolves with
 * the write's value after local durability (`none`/`background`) or after
 * global durability (`await`). Rejects on local-tier failure in every mode
 * and on global-tier failure in `await` mode; a `background` global rejection
 * reaches {@link SettlementHooks.onGlobalError} only.
 */
export async function settleDurableWrite<T>(
  write: DurableWrite<T>,
  updateDiagnostics: (update: (diagnostics: RuntimeDiagnostics) => void) => void,
  globalTier: GlobalTierMode,
  hooks: SettlementHooks = {},
): Promise<T> {
  updateDiagnostics((diagnostics) => diagnostics.pendingLocalWrites += 1);
  let result: T;
  try {
    result = await write.wait({ tier: "local" });
  } catch (error) {
    updateDiagnostics((diagnostics) => {
      diagnostics.pendingLocalWrites -= 1;
      diagnostics.mutationErrors += 1;
    });
    throw error;
  }
  updateDiagnostics((diagnostics) => {
    diagnostics.pendingLocalWrites -= 1;
    diagnostics.localWaitCalls += 1;
  });
  hooks.onLocal?.();
  if (globalTier === "none") return result;
  updateDiagnostics((diagnostics) => diagnostics.pendingGlobalWrites += 1);
  const globalSettled = write.wait({ tier: "global" }).then(
    () => {
      hooks.onGlobal?.();
    },
    (error) => {
      updateDiagnostics((diagnostics) => diagnostics.mutationErrors += 1);
      hooks.onGlobalError?.(error);
      // Background rejections are fully handled here; only inline waiters
      // observe the rejection.
      if (globalTier === "await") throw error;
    },
  ).finally(() => updateDiagnostics((diagnostics) => diagnostics.pendingGlobalWrites -= 1));
  if (globalTier === "await") await globalSettled;
  else void globalSettled;
  return result;
}
