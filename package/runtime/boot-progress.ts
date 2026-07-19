/**
 * Package-owned first-load progress: the phases between a painted shell and an
 * open runtime, including the engine download that dominates a cold first
 * visit.
 *
 * The build stamps every prerendered page with a preload link for the engine
 * binary carrying its uncompressed byte size (`data-lofi-engine`). Before the
 * runtime opens, {@link BootProgressTracker.warmEngineDownload} streams that
 * URL through the same preload the browser already started, reporting byte
 * progress as it goes; the engine's own fetch then finds the bytes in the HTTP
 * cache. On a repeat visit the service worker answers the warm-up from the
 * precached shell, so the download phase passes in one step. The warm-up only
 * informs — any failure leaves the engine to resolve its binary exactly as it
 * would without one.
 *
 * @module
 */

/**
 * Phases between a painted shell and an open runtime.
 *
 * - `pending` — the runtime has not been requested yet.
 * - `downloading` — the engine binary is downloading; on a cold first visit
 *   this is the long phase, with byte progress in {@link BootProgress}.
 * - `opening` — the engine is instantiating and persistent storage is opening.
 * - `ready` — the runtime is open; live queries answer from local data.
 * - `failed` — the runtime could not open; the cause is in runtime
 *   diagnostics (`startupFailure`).
 */
export type BootProgressPhase = "pending" | "downloading" | "opening" | "ready" | "failed";

/** Live first-load progress for application status UI. */
export type BootProgress = {
  phase: BootProgressPhase;
  /** Engine bytes received so far, uncompressed. */
  loadedBytes: number;
  /** The engine binary's uncompressed size when the shell declares it, else `null`. */
  totalBytes: number | null;
};

/** One engine binary reference declared by the built shell. */
export type EngineAssetReference = {
  url: string;
  bytes: number | null;
};

/** Injectable surfaces used to test the tracker deterministically. */
export type BootProgressTrackerDependencies = {
  /** The shell's engine preload declaration, or `null` outside a built page. */
  readonly engineAsset?: () => EngineAssetReference | null;
  readonly fetchImpl?: typeof fetch;
};

/** Stateful first-load progress shared by the runtime and application UI. */
export type BootProgressTracker = {
  /** The current progress snapshot. */
  get(): BootProgress;
  /** Subscribes to progress changes; returns an idempotent unsubscribe function. */
  subscribe(listener: (progress: BootProgress) => void): () => void;
  /**
   * Downloads the engine binary once per document with byte progress, priming
   * the HTTP cache the engine's own fetch reads. Resolves without throwing on
   * any failure; the engine then resolves its binary as it would without a
   * warm-up.
   */
  warmEngineDownload(): Promise<void>;
  /** Records a phase transition driven by the runtime lifecycle. */
  mark(phase: "opening" | "ready" | "failed"): void;
};

function declaredEngineAsset(): EngineAssetReference | null {
  if (typeof document === "undefined") return null;
  const link = document.querySelector('link[rel="preload"][data-lofi-engine]');
  if (!(link instanceof HTMLLinkElement) || !link.href) return null;
  const bytes = Number(link.getAttribute("data-lofi-engine"));
  return { url: link.href, bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null };
}

/**
 * Creates an isolated progress tracker over injectable surfaces. The
 * package-wide wrappers ({@link getBootProgress},
 * {@link subscribeBootProgress}) read the shared tracker the runtime drives;
 * this factory exists for isolated instances — deterministic tests and custom
 * hosts that manage their own tracker.
 */
export function createBootProgressTracker(
  dependencies: BootProgressTrackerDependencies = {},
): BootProgressTracker {
  const listeners = new Set<(progress: BootProgress) => void>();
  let progress: BootProgress = { phase: "pending", loadedBytes: 0, totalBytes: null };
  let warmup: Promise<void> | null = null;

  const publish = (next: BootProgress) => {
    progress = next;
    for (const listener of listeners) listener(progress);
  };

  const download = async (): Promise<void> => {
    const asset = (dependencies.engineAsset ?? declaredEngineAsset)();
    if (!asset) return;
    publish({ phase: "downloading", loadedBytes: 0, totalBytes: asset.bytes });
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const response = await fetchImpl(asset.url);
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      publish({ ...progress, loadedBytes: loaded });
    }
  };

  return {
    get: () => progress,
    subscribe(listener) {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    warmEngineDownload() {
      // One warm-up per document: a recreated runtime reopens against bytes
      // that are already local, so only the phases replay.
      warmup ??= download().catch(() => undefined);
      return warmup;
    },
    mark(phase) {
      publish({ ...progress, phase });
    },
  };
}

/** Shared tracker used by the package runtime and the optional Preact bindings. */
export const bootProgressTracker: BootProgressTracker = createBootProgressTracker();

/** Returns the current first-load progress snapshot. */
export function getBootProgress(): BootProgress {
  return bootProgressTracker.get();
}

/** Subscribes to first-load progress and returns an idempotent unsubscribe function. */
export function subscribeBootProgress(
  listener: (progress: BootProgress) => void,
): () => void {
  return bootProgressTracker.subscribe(listener);
}
