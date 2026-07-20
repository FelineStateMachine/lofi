/**
 * Preact binding for the durable notice queue behind `s.notice`: the live list
 * of user-visible messages an effect enqueued when a write settled, plus the
 * dismissal action. Apps render their own surface over this, or use the
 * built-in {@link Notices} component.
 *
 * @module
 */

import { useEffect, useState } from "preact/hooks";
import {
  dismissAllNotices,
  dismissNotice,
  listNotices,
  type NoticeEntry,
  subscribeNotices,
} from "../runtime/mod.ts";

export type { NoticeEntry, NoticeTone } from "../runtime/mod.ts";

/** The live notices and the actions to retire them. */
export type NoticesSurface = {
  /** The live notices: enqueued, not dismissed, not past their TTL. */
  notices: readonly NoticeEntry[];
  /** Dismisses one notice by id. */
  dismiss: (id: string) => void;
  /** Dismisses every notice. */
  dismissAll: () => void;
};

/**
 * Subscribes a Preact component to the durable notice queue. The list stays
 * live across enqueues (including effects that fire at a boot re-arm),
 * dismissals, and TTL retirement.
 *
 * @example
 * ```tsx
 * import { useNotices } from "@nzip/lofi/preact";
 *
 * const { notices, dismiss } = useNotices();
 * return notices.map((n) => (
 *   <div key={n.id} data-tone={n.tone}>
 *     {n.message}
 *     <button type="button" onClick={() => dismiss(n.id)}>Dismiss</button>
 *   </div>
 * ));
 * ```
 *
 * @returns The live notices and the dismissal actions.
 */
export function useNotices(): NoticesSurface {
  const [notices, setNotices] = useState<readonly NoticeEntry[]>(() => listNotices());
  useEffect(() => {
    // Publish the current list once on mount — an effect may have enqueued
    // before this component subscribed — then follow every change.
    setNotices(listNotices());
    return subscribeNotices(() => setNotices(listNotices()));
  }, []);
  return { notices, dismiss: dismissNotice, dismissAll: dismissAllNotices };
}
