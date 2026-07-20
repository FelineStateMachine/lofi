import type { VNode } from "preact";
// Package-owned optional notices surface.
import { type NoticeEntry, useNotices } from "./use-notices.ts";

/** Props for the built-in {@link Notices} surface. */
export type NoticesProps = {
  /** Accessible label for the region; defaults to "Notifications". */
  label?: string;
  /** Renders one notice; defaults to the built-in row with a dismiss button. */
  children?: (notice: NoticeEntry, dismiss: () => void) => VNode;
};

/**
 * The built-in durable-notice surface: renders the live `s.notice` queue as an
 * ARIA live region so a message enqueued when a write settled — success or the
 * "a rejected write still flashed success" case — is announced and dismissable.
 * Optional and entirely public: it is `useNotices` plus default markup, so an
 * app can drop it and render its own (a toast stack, a banner) over the same
 * hook.
 *
 * @example
 * ```tsx
 * import { Notices } from "@nzip/lofi/preact";
 *
 * export function AppChrome() {
 *   return <Notices />;
 * }
 * ```
 *
 * @param props Optional region label and a custom per-notice renderer.
 * @returns The live notices region, or `null` when the queue is empty.
 */
export function Notices({ label = "Notifications", children }: NoticesProps): VNode {
  const { notices, dismiss } = useNotices();
  // The live region stays mounted even when empty: a screen reader only
  // announces mutations to a region already in the DOM, so inserting the
  // region together with its first notice would drop that first announcement —
  // exactly the message this surface exists to deliver.
  return (
    <section
      class="lofi-notices"
      aria-label={label}
      aria-live="polite"
      hidden={notices.length === 0}
    >
      {notices.map((notice) =>
        children
          ? <div key={notice.id}>{children(notice, () => dismiss(notice.id))}</div>
          : (
            <div key={notice.id} class="lofi-notice" data-tone={notice.tone} role="status">
              <p class="lofi-notice-message">{notice.message}</p>
              <button
                type="button"
                class="lofi-notice-dismiss"
                aria-label="Dismiss notification"
                onClick={() => dismiss(notice.id)}
              >
                Dismiss
              </button>
            </div>
          )
      )}
    </section>
  );
}
