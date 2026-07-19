import type { VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  type PwaController,
  pwaController,
  pwaFailureMessage,
  type PwaState,
} from "../runtime/pwa.ts";
import { type StorageForkSurface, useStorageFork } from "./use-storage-fork.ts";

export { pwaFailureMessage } from "../runtime/pwa.ts";
export type {
  PwaController,
  PwaFailureCode,
  PwaInstallState,
  PwaState,
  PwaUpdateState,
  PwaWorkerState,
} from "../runtime/pwa.ts";

/**
 * Subscribes a Preact component to an isolated or shared PWA controller.
 *
 * @example
 * ```tsx
 * import { usePwaState } from "@nzip/lofi/preact";
 *
 * const pwa = usePwaState();
 * const updateReady = pwa.update === "ready";
 * ```
 *
 * @param controller The controller to observe; defaults to the package-wide PWA controller.
 * @returns The current install/update state, kept live via subscription.
 */
export function usePwaState(controller: PwaController = pwaController): PwaState {
  const [state, setState] = useState<PwaState>(controller.getState());
  useEffect(() => controller.subscribe(setState), [controller]);
  return state;
}

/** Optional controller, fork guard, and heading text for {@link PwaActions}. */
export interface PwaActionsProps {
  /** Controller to observe; defaults to the package-wide PWA controller. */
  readonly controller?: PwaController;
  /** Fork guard to observe; defaults to the package-wide guard. */
  readonly fork?: StorageForkSurface;
  /** Heading rendered above install or update actions. */
  readonly title?: string;
}

/**
 * A composable install/update surface that keeps browser event handling package-owned.
 *
 * @example
 * ```tsx
 * import { PwaActions } from "@nzip/lofi/preact";
 *
 * <PwaActions title="Install this app" />;
 * ```
 *
 * @param props An optional controller override and heading text.
 * @returns The install/update section, or `null` when no action or status is relevant.
 */
export function PwaActions({
  controller = pwaController,
  fork,
  title = "Install & updates",
}: PwaActionsProps): VNode | null {
  const state = usePwaState(controller);
  const forkState = useStorageFork(fork);
  const visible = state.install === "available" || state.install === "manual-ios" ||
    state.install === "manual-browser" || state.install === "unsupported" ||
    state.install === "accepted" || state.install === "dismissed" ||
    state.update !== "idle" || Boolean(state.failure);
  if (!visible) return null;

  return (
    <section class="pwa-actions" aria-labelledby="pwa-actions-title">
      <h3 id="pwa-actions-title">{title}</h3>
      {state.install === "available" && (
        <button
          type="button"
          onClick={() => void controller.requestInstall()}
        >
          Install app
        </button>
      )}
      {state.install === "accepted" && (
        <p role="status">Installation accepted. Follow the browser prompt to finish.</p>
      )}
      {state.install === "dismissed" && (
        <p role="status">Installation dismissed. You can use the browser install menu later.</p>
      )}
      {state.install === "manual-ios" && (
        <div class="pwa-ios-guidance">
          {forkState.state === "browser-data-at-risk" && (
            <p class="pwa-fork-warning" role="alert">
              Installing opens a fresh, empty copy of this app — the data you created here stays in
              Safari and is not carried over. Turn on sync or back up your account first, then
              restore it in the installed app.
            </p>
          )}
          <p>Install this app on your iPhone or iPad:</p>
          <ol>
            <li>Open the Share menu.</li>
            <li>Choose Add to Home Screen.</li>
            <li>Confirm Add.</li>
          </ol>
        </div>
      )}
      {state.install === "manual-browser" && (
        <div class="pwa-browser-guidance">
          <p>No in-page install button is available right now.</p>
          <p>Look in its menu for Install app or Add to Home Screen, if offered.</p>
        </div>
      )}
      {state.install === "unsupported" && (
        <p>Installation is not supported in this browser or browsing context.</p>
      )}
      {state.update === "checking" && <p role="status">Checking for updates…</p>}
      {state.update === "installing" && <p role="status">Installing update…</p>}
      {state.update === "ready" && (
        <button
          type="button"
          onClick={() => controller.applyUpdate()}
        >
          Update app
        </button>
      )}
      {state.update === "applying" && <p role="status">Applying update…</p>}
      {state.failure && (
        <p class="pwa-error" role="alert">{pwaFailureMessage(state.failure.code)}</p>
      )}
    </section>
  );
}
