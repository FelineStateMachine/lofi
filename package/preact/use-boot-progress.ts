/**
 * Preact binding for first-load progress: the phases between a painted shell
 * and an open runtime, for status UI that names the engine download a cold
 * first visit actually waits on.
 *
 * @module
 */

import { useEffect, useState } from "preact/hooks";
import {
  type BootProgress,
  getBootProgress,
  subscribeBootProgress,
} from "../runtime/boot-progress.ts";

export type { BootProgress, BootProgressPhase } from "../runtime/boot-progress.ts";

/**
 * Subscribes a Preact component to first-load progress, so a loading state can
 * distinguish the engine download (with byte progress on a cold first visit)
 * from opening persistent storage.
 *
 * @example
 * ```tsx
 * import { useBootProgress } from "@nzip/lofi/preact";
 *
 * const boot = useBootProgress();
 * if (boot.phase === "downloading" && boot.totalBytes) {
 *   return <p>Downloading the app · {progressLabel(boot)}</p>;
 * }
 * ```
 *
 * @returns The current first-load progress, kept live via subscription.
 */
export function useBootProgress(): BootProgress {
  const [progress, setProgress] = useState<BootProgress>(getBootProgress());
  useEffect(() => subscribeBootProgress(setProgress), []);
  return progress;
}
