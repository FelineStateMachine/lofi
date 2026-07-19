/**
 * Preact bindings for the per-write sync lifecycle: one write's stage, the
 * reload-safe pending set, and per-row sync badges. All three are
 * level-triggered — they render current truth on mount, so a component that
 * mounts after a transition sees the same state as one that watched it happen.
 *
 * @module
 */

import { useEffect, useState } from "preact/hooks";
import type { WriteHandle, WriteRejection, WriteStage } from "../runtime/write-handle.ts";
import {
  getWriteLedger,
  type PendingWritesSnapshot,
  type RowSyncStatus,
} from "../runtime/write-ledger.ts";

/** The observable state of one write, re-rendered on every stage change. */
export type WriteState = {
  /** The write's current stage, or `null` while no write is being observed. */
  stage: WriteStage | null;
  /** The rejection carried by a `rejected` write. */
  reason: WriteRejection | null;
};

/**
 * Observes one write's lifecycle. Pass the handle returned by a verb or a
 * table mutation; the component re-renders on each stage change and a
 * late-mounted component sees the current stage immediately.
 *
 * @example
 * ```tsx
 * const [write, setWrite] = useState<WriteHandle<Order> | null>(null);
 * const { stage, reason } = useWrite(write);
 * // stage: "saving" | "saved" | "syncing" | "synced" | "rejected" | null
 * ```
 */
export function useWrite<T>(write: WriteHandle<T> | null | undefined): WriteState {
  const [state, setState] = useState<WriteState>(() => ({
    stage: write?.stage ?? null,
    reason: write?.reason ?? null,
  }));
  useEffect(() => {
    if (!write) {
      setState({ stage: null, reason: null });
      return;
    }
    return write.subscribe(() => setState({ stage: write.stage, reason: write.reason }));
  }, [write]);
  return state;
}

/**
 * The reload-safe set of writes still waiting to sync, for "N changes waiting
 * to sync" indicators. The set is rebuilt from the durable journal at boot,
 * so it survives a reload with writes still pending.
 *
 * @example
 * ```tsx
 * const pending = usePendingWrites();
 * return pending.count > 0 ? <p>{pending.count} change(s) waiting to sync</p> : null;
 * ```
 */
export function usePendingWrites(): PendingWritesSnapshot {
  const [snapshot, setSnapshot] = useState<PendingWritesSnapshot>({ count: 0, writes: [] });
  // The ledger is resolved inside the effect so server-side prerendering of an
  // island never opens browser storage.
  useEffect(() => {
    const ledger = getWriteLedger();
    return ledger.subscribe(() => setSnapshot(ledger.getPendingSnapshot()));
  }, []);
  return snapshot;
}

/**
 * The sync status of one row for per-row badges: `waiting` while a journaled
 * write touching the row has not settled, `rejected` when the row's latest
 * settled write was denied, and `synced` otherwise.
 *
 * @example
 * ```tsx
 * const status = useSyncStatus(task);
 * {status === "waiting" && <span class="badge">waiting to sync</span>}
 * ```
 */
export function useSyncStatus(row: { id: string } | null | undefined): RowSyncStatus {
  const rowId = row?.id ?? null;
  const [status, setStatus] = useState<RowSyncStatus>("synced");
  useEffect(() => {
    if (rowId === null) {
      setStatus("synced");
      return;
    }
    const ledger = getWriteLedger();
    return ledger.subscribe(() => setStatus(ledger.rowStatus(rowId)));
  }, [rowId]);
  return status;
}
