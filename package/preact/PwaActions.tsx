import type { VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  type PwaController,
  pwaController,
  pwaFailureMessage,
  type PwaState,
} from "../runtime/pwa.ts";

export { pwaFailureMessage } from "../runtime/pwa.ts";
export type { PwaController, PwaFailureCode, PwaState } from "../runtime/pwa.ts";

/** Subscribes a Preact component to an isolated or shared PWA controller. */
export function usePwaState(controller: PwaController = pwaController): PwaState {
  const [state, setState] = useState<PwaState>(controller.getState());
  useEffect(() => controller.subscribe(setState), [controller]);
  return state;
}

/** Optional controller and heading text for {@link PwaActions}. */
export interface PwaActionsProps {
  /** Controller to observe; defaults to the package-wide PWA controller. */
  readonly controller?: PwaController;
  /** Heading rendered above install or update actions. */
  readonly title?: string;
}

/** A composable install/update surface that keeps browser event handling package-owned. */
export function PwaActions({
  controller = pwaController,
  title = "Install & updates",
}: PwaActionsProps): VNode | null {
  const state = usePwaState(controller);
  const visible = state.install === "available" || state.install === "manual-ios" ||
    state.install === "accepted" || state.install === "dismissed" ||
    state.worker === "update-available" || Boolean(state.failure);
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
          <p>Install this app on your iPhone or iPad:</p>
          <ol>
            <li>Open the Share menu.</li>
            <li>Choose Add to Home Screen.</li>
            <li>Confirm Add.</li>
          </ol>
        </div>
      )}
      {state.worker === "update-available" && (
        <button
          type="button"
          onClick={() => controller.applyUpdate()}
        >
          Update app
        </button>
      )}
      {state.failure && (
        <p class="pwa-error" role="alert">{pwaFailureMessage(state.failure.code)}</p>
      )}
    </section>
  );
}
