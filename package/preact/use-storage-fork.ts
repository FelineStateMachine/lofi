/**
 * Preact binding for the storage-container fork guard: the live fork state,
 * for apps that render their own surface in place of the framework's default
 * fork notice.
 *
 * @module
 */

import { useEffect, useState } from "preact/hooks";
import {
  type StorageForkGuard,
  storageForkGuard,
  type StorageForkState,
} from "../runtime/storage-fork.ts";

export type { StorageForkState } from "../runtime/storage-fork.ts";

/** The guard surface a component observes; defaults to the shared guard. */
export type StorageForkSurface = Pick<StorageForkGuard, "getState" | "subscribe">;

/**
 * Subscribes a Preact component to the storage-container fork guard, so apps
 * can render their own install warning or fork notice in place of the
 * framework default (suppress the default with `pwa: { forkNotice: "none" }`
 * in `defineLofiApp`).
 *
 * @example
 * ```tsx
 * import { useStorageFork } from "@nzip/lofi/preact";
 *
 * const fork = useStorageFork();
 * if (fork.state === "fork-detected") return <ForkNotice message={fork.message} />;
 * ```
 *
 * @param guard The guard to observe; defaults to the package-wide guard.
 * @returns The current fork state, kept live via subscription.
 */
export function useStorageFork(guard: StorageForkSurface = storageForkGuard): StorageForkState {
  const [state, setState] = useState<StorageForkState>(guard.getState());
  useEffect(() => guard.subscribe(setState), [guard]);
  return state;
}
