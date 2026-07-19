/// <reference path="./env.d.ts" />
/**
 * The boot compatibility gate between the running bundle's supported schema
 * range and the schema version the local data was last written under.
 *
 * A long-lived offline shell can be older than the data another tab or
 * device migrated. Booting that old code read-write onto newer data is a
 * defect, not an author choice, so the gate refuses writes (reads continue)
 * and names the one remediation: update the app. Code ahead of data is the
 * normal path — migrations run as they always have — and the gate then
 * stamps the local record forward. The gate never hard-fails boot: reads go
 * through the engine's own machinery, and a truly unreadable store surfaces
 * as a startup failure there.
 *
 * The bundle's range comes from the build-stamped `lofi-schema.json`, which
 * ships in the precache so an offline shell still knows its own range; the
 * local record lives in `localStorage` beside the store, readable before the
 * runtime fully boots. Zero configuration is safe: in development the gate
 * is inert, a missing manifest leaves writes enabled, and the framework
 * renders a minimal default banner that apps may replace via the optional
 * `pwa` block of `defineLofiApp` and the `useSchemaCompat` Preact hook.
 *
 * @module
 */

import {
  classifySchemaCompat,
  parseLocalSchemaVersion,
  parseSchemaCompatManifest,
  type SchemaVersionRange,
  serializeLocalSchemaVersion,
} from "../schema/compat.ts";
import { getLofiApp } from "./app.ts";
import { anchorAppId } from "./data-sink.ts";
import { type PwaController, pwaController } from "./pwa.ts";

/** Why writes are refused: newer-schema data, or a stale tab after a swap. */
export type SchemaCompatReason = "schema" | "stale-tab";

/** The compatibility state exposed through diagnostics and the Preact hook. */
export type SchemaCompatState =
  /** No verdict: development mode, no manifest, or the check is in flight. */
  | { state: "unchecked"; reason: "inactive" | "development" | "no-manifest" | "pending" }
  /** Writes are allowed; `classification` says why. */
  | { state: "compatible"; classification: "first-boot" | "equal" | "code-ahead" }
  /** The data is newer than this code: read-only until the app updates. */
  | { state: "data-ahead"; reason: SchemaCompatReason; message: string }
  /** An update that resolves the mismatch is installing or applying. */
  | { state: "updating"; message: string };

const dataAheadMessage =
  "This device's data was saved by a newer version of the app, so editing is paused to protect " +
  "it. Reading still works. Update the app to continue editing.";
const staleTabMessage =
  "A newer version of the app is now active in another tab. Reload this tab to continue editing.";
const updatingMessage = "Updating the app… editing resumes when the update finishes.";

/**
 * Raised when a mutation is refused because the local data is ahead of the
 * running code. It surfaces through the ordinary error path of whatever
 * performed the write — a verb call's handle fails, a table
 * `insert`/`update`/`delete` rejects — with no journal entry or effect;
 * reads keep working. The remediation is updating the app: watch
 * {@link SchemaCompatState} via `useSchemaCompat` or
 * {@link subscribeSchemaCompat}, and offer `applyPwaUpdate` when the update
 * is ready.
 */
export class SchemaCompatibilityError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "SchemaCompatibilityError";
  /** Stable category for write-refusal classification. */
  readonly code = "schema-data-ahead";
}

/** The update surface the gate drives as its remediation. */
export type SchemaCompatUpdateSurface = Pick<
  PwaController,
  "getState" | "subscribe" | "checkForUpdate"
>;

/** Injectable browser surfaces used to test the gate deterministically. */
export type SchemaCompatGateDependencies = {
  readonly production?: () => boolean;
  /** Loads the raw bundle manifest value; `null` means the file is absent. */
  readonly loadManifest?: () => Promise<unknown>;
  readonly storage?: () => Pick<Storage, "getItem" | "setItem"> | undefined;
  readonly storageKey?: () => string;
  /** Target for cross-tab `storage` events; defaults to the window. */
  readonly storageEvents?: () => EventTarget | undefined;
  readonly controller?: () => SchemaCompatUpdateSurface | undefined;
  /** Upper bound a write waits for the pending verdict; defaults to 8 seconds. */
  readonly settleTimeoutMs?: number;
};

/** The boot compatibility gate between bundle schema range and local data. */
export type SchemaCompatGate = {
  /** Starts the check once; later calls are no-ops. */
  start(): void;
  /** The current compatibility state snapshot. */
  getState(): SchemaCompatState;
  /** Subscribes to state changes; the listener runs immediately. */
  subscribe(listener: (state: SchemaCompatState) => void): () => void;
  /** Resolves when writes are allowed; rejects with {@link SchemaCompatibilityError}. */
  assertWritable(): Promise<void>;
  /** Records that the runtime opened read-write; stamps the local version. */
  markRuntimeWritable(): void;
  /** Marks this tab stale after another tab's worker swap; refuses writes. */
  markStaleTab(): void;
};

function defaultLoadManifest(): Promise<unknown> {
  const base = new URL(import.meta.env.BASE_URL, document.location.origin);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return fetch(new URL("lofi-schema.json", base)).then(
    (response) => {
      if (response.status === 404) {
        void response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        void response.body?.cancel();
        throw new Error(`schema manifest failed: HTTP ${response.status}`);
      }
      return response.json();
    },
  );
}

/** Creates an isolated gate, primarily for tests; boot uses the shared one. */
export function createSchemaCompatGate(
  dependencies: SchemaCompatGateDependencies = {},
): SchemaCompatGate {
  const subscribers = new Set<(state: SchemaCompatState) => void>();
  let state: SchemaCompatState = { state: "unchecked", reason: "inactive" };
  let bundle: SchemaVersionRange | null = null;
  let staleTab = false;
  let started = false;
  let stamped = false;
  let runtimeWritable = false;
  let settled = false;
  const settleWaiters = new Set<() => void>();

  const storage = () => {
    if (dependencies.storage) return dependencies.storage();
    try {
      return typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
      return undefined;
    }
  };
  const storageKey = () => dependencies.storageKey?.() ?? `lofi:schema-version:${anchorAppId}`;
  const controller = () => (dependencies.controller ? dependencies.controller() : pwaController);
  const settleTimeoutMs = dependencies.settleTimeoutMs ?? 8_000;

  const publish = (next: SchemaCompatState) => {
    state = next;
    for (const subscriber of subscribers) subscriber(state);
  };

  const settle = () => {
    if (settled) return;
    settled = true;
    for (const waiter of settleWaiters) waiter();
    settleWaiters.clear();
  };

  const readLocal = (): SchemaVersionRange | null => {
    try {
      return parseLocalSchemaVersion(storage()?.getItem(storageKey()) ?? null);
    } catch {
      return null;
    }
  };

  const stamp = () => {
    if (!bundle || stamped) return;
    stamped = true;
    try {
      storage()?.setItem(storageKey(), serializeLocalSchemaVersion(bundle));
    } catch {
      // A private-mode storage failure must not affect a working runtime.
    }
  };

  // The overlay: while the mismatch stands and an update is actually moving,
  // the surfaced state is "updating" rather than a bare refusal.
  const effectiveState = (base: SchemaCompatState): SchemaCompatState => {
    if (base.state !== "data-ahead") return base;
    const update = controller()?.getState().update;
    return update === "installing" || update === "applying"
      ? { state: "updating", message: updatingMessage }
      : base;
  };

  let base: SchemaCompatState = state;
  const setBase = (next: SchemaCompatState) => {
    base = next;
    publish(effectiveState(base));
  };

  const evaluate = () => {
    if (staleTab) {
      setBase({ state: "data-ahead", reason: "stale-tab", message: staleTabMessage });
      return;
    }
    if (!bundle) return;
    const classification = classifySchemaCompat(bundle, readLocal());
    if (classification === "data-ahead" || classification === "unrelated") {
      setBase({ state: "data-ahead", reason: "schema", message: dataAheadMessage });
      // The remediation is a newer bundle; kick a bounded update check. Later
      // foreground signals re-check through the controller's own machinery.
      void controller()?.checkForUpdate();
      return;
    }
    setBase({
      state: "compatible",
      classification: classification === "first-boot" ? "first-boot" : classification,
    });
    if (runtimeWritable) stamp();
  };

  const attachPwaOverlay = () => {
    controller()?.subscribe(() => {
      publish(effectiveState(base));
    });
  };

  const attachStorageEvents = () => {
    const target = dependencies.storageEvents
      ? dependencies.storageEvents()
      : (typeof window === "undefined" ? undefined : window);
    // Another tab advancing the stamp while this one runs is the live form of
    // the same hazard; re-evaluate so this tab flips to read-only in place.
    target?.addEventListener("storage", (event) => {
      const key = (event as StorageEvent).key;
      if (key === null || key === storageKey()) evaluate();
    });
  };

  return {
    start() {
      if (started) return;
      started = true;
      if (!(dependencies.production?.() ?? import.meta.env.PROD)) {
        setBase({ state: "unchecked", reason: "development" });
        settle();
        return;
      }
      setBase({ state: "unchecked", reason: "pending" });
      attachPwaOverlay();
      attachStorageEvents();
      const load = dependencies.loadManifest ?? defaultLoadManifest;
      void Promise.resolve().then(load).then(
        (value) => {
          const manifest = value === null ? null : parseSchemaCompatManifest(value);
          if (!manifest) {
            setBase({ state: "unchecked", reason: "no-manifest" });
          } else {
            bundle = { head: manifest.head, lineage: manifest.lineage };
            evaluate();
          }
          settle();
        },
        () => {
          // An unreachable manifest must not brick a working app; the shell
          // that matters offline serves it from its own precache.
          setBase({ state: "unchecked", reason: "no-manifest" });
          settle();
        },
      );
    },
    getState: () => state,
    subscribe(listener) {
      subscribers.add(listener);
      listener(state);
      return () => subscribers.delete(listener);
    },
    async assertWritable() {
      if (started && !settled) {
        await new Promise<void>((resolve) => {
          settleWaiters.add(resolve);
          const timer = setTimeout(resolve, settleTimeoutMs);
          settleWaiters.add(() => clearTimeout(timer));
        });
      }
      if (state.state === "data-ahead" || state.state === "updating") {
        throw new SchemaCompatibilityError(
          state.state === "updating" ? updatingMessage : state.message,
        );
      }
    },
    markRuntimeWritable() {
      runtimeWritable = true;
      if (base.state === "compatible") stamp();
    },
    markStaleTab() {
      staleTab = true;
      evaluate();
    },
  };
}

/** Shared gate used by boot, the runtime, and the optional Preact bindings. */
export const schemaCompatGate: SchemaCompatGate = createSchemaCompatGate();

/** Returns the shared gate's current compatibility state snapshot. */
export function getSchemaCompatState(): SchemaCompatState {
  return schemaCompatGate.getState();
}

/** Subscribes to shared compatibility state; returns an unsubscribe function. */
export function subscribeSchemaCompat(
  listener: (state: SchemaCompatState) => void,
): () => void {
  return schemaCompatGate.subscribe(listener);
}

/** Resolves when writes are allowed; rejects with {@link SchemaCompatibilityError}. */
export function assertSchemaWritable(): Promise<void> {
  return schemaCompatGate.assertWritable();
}

/** One-line label for diagnostic surfaces (development inspector, DeviceStatus). */
export function describeSchemaCompat(state: SchemaCompatState): string {
  switch (state.state) {
    case "unchecked":
      switch (state.reason) {
        case "development":
          return "not checked (development)";
        case "no-manifest":
          return "not checked (no compatibility manifest)";
        case "pending":
          return "checking…";
        default:
          return "not checked";
      }
    case "compatible":
      return state.classification === "code-ahead"
        ? "compatible (migrations pending)"
        : "compatible";
    case "data-ahead":
      return state.reason === "stale-tab"
        ? "read-only — reload this tab"
        : "read-only — data is newer than this app version";
    case "updating":
      return "updating…";
  }
}

// ---------------------------------------------------------------------------
// Default banner: the zero-configuration surface for read-only mode. A plain
// DOM element (no UI framework) so it works in any app; authors opt out with
// `pwa: { updateBanner: "none" }` and render their own from useSchemaCompat.
// ---------------------------------------------------------------------------

const bannerClass = "lofi-schema-compat-banner";

function bannerAction(state: SchemaCompatState): { label: string; run: () => void } | null {
  if (state.state !== "data-ahead") return null;
  if (state.reason === "stale-tab") {
    return { label: "Reload", run: () => location.reload() };
  }
  if (pwaController.getState().update === "ready") {
    return { label: "Update app", run: () => void pwaController.applyUpdate() };
  }
  return { label: "Check for updates", run: () => void pwaController.checkForUpdate() };
}

function renderDefaultBanner(state: SchemaCompatState): void {
  const existing = document.querySelector(`.${bannerClass}`);
  if (state.state !== "data-ahead" && state.state !== "updating") {
    existing?.remove();
    return;
  }
  const banner = existing ?? document.createElement("div");
  banner.textContent = "";
  banner.className = bannerClass;
  banner.setAttribute("role", "alert");
  (banner as HTMLElement).style.cssText =
    "position:fixed;inset:auto 0 0 0;z-index:2147483000;display:flex;gap:0.75rem;" +
    "align-items:center;justify-content:center;flex-wrap:wrap;padding:0.75rem 1rem;" +
    "background:#1f2430;color:#fff;font:14px/1.4 system-ui,sans-serif;text-align:center;";
  const message = document.createElement("span");
  message.textContent = state.message;
  banner.append(message);
  const action = bannerAction(state);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.style.cssText =
      "padding:0.35rem 0.9rem;border:1px solid #fff;border-radius:0.4rem;background:none;" +
      "color:inherit;font:inherit;cursor:pointer;";
    button.addEventListener("click", action.run);
    banner.append(button);
  }
  if (!existing) document.body.append(banner);
}

/**
 * Mounts the framework's minimal read-only banner unless the app opted out.
 * Called once by boot; safe without a defined app (defaults apply).
 */
export function mountDefaultCompatBanner(): void {
  if (typeof document === "undefined") return;
  let preference: "default" | "none" = "default";
  try {
    preference = getLofiApp().pwa?.updateBanner ?? "default";
  } catch {
    // No app definition yet; the safe default applies.
  }
  if (preference === "none") return;
  schemaCompatGate.subscribe(renderDefaultBanner);
  // Re-render on update-state changes so the action label tracks readiness.
  pwaController.subscribe(() => renderDefaultBanner(schemaCompatGate.getState()));
}
