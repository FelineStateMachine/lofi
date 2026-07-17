/**
 * Opt-in geometry observation for desktop Window Controls Overlay layouts.
 *
 * @module
 */

/** A value-only copy of the titlebar area available to application content. */
export type WindowControlsOverlayGeometry = {
  readonly visible: boolean;
  readonly titlebarArea: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
};

/** Minimal browser surface consumed by this recipe. */
export type WindowControlsOverlayClient = {
  readonly visible: boolean;
  getTitlebarAreaRect(): Pick<DOMRectReadOnly, "x" | "y" | "width" | "height">;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
};

/** Disposable result from installing the geometry observer. */
export type WindowControlsOverlayObserver = {
  readonly supported: boolean;
  dispose(): void;
};

/** Options for observing overlay visibility and geometry changes. */
export type ObserveWindowControlsOverlayOptions = {
  /** Called initially and whenever browser geometry changes. */
  onGeometry(geometry: WindowControlsOverlayGeometry): void;
  /** Override the browser API for tests. */
  client?: WindowControlsOverlayClient;
};

function browserClient(): WindowControlsOverlayClient | undefined {
  if (typeof navigator === "undefined") return undefined;
  const candidate = navigator as Navigator & {
    windowControlsOverlay?: WindowControlsOverlayClient;
  };
  const client = candidate.windowControlsOverlay;
  return client && typeof client.getTitlebarAreaRect === "function" &&
      typeof client.addEventListener === "function" &&
      typeof client.removeEventListener === "function"
    ? client
    : undefined;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function readGeometry(client: WindowControlsOverlayClient): WindowControlsOverlayGeometry {
  const rect = client.getTitlebarAreaRect();
  return {
    visible: client.visible === true,
    titlebarArea: {
      x: finiteNonNegative(rect.x),
      y: finiteNonNegative(rect.y),
      width: finiteNonNegative(rect.width),
      height: finiteNonNegative(rect.height),
    },
  };
}

/**
 * Observe the experimental Window Controls Overlay geometry surface.
 *
 * CSS `titlebar-area-*` environment variables should own collision-free
 * layout. This observer is for state that genuinely needs geometry changes.
 * Unsupported browsers retain the ordinary standalone header and receive no
 * callback.
 */
export function observeWindowControlsOverlay(
  options: ObserveWindowControlsOverlayOptions,
): WindowControlsOverlayObserver {
  const client = options.client ?? browserClient();
  if (!client) return { supported: false, dispose() {} };
  let active = true;
  const update = () => {
    if (active) options.onGeometry(readGeometry(client));
  };
  client.addEventListener("geometrychange", update);
  update();
  return {
    supported: true,
    dispose() {
      if (!active) return;
      active = false;
      client.removeEventListener("geometrychange", update);
    },
  };
}
