/// <reference path="./env.d.ts" />
/**
 * The storage-container fork guard for installed web apps.
 *
 * WebKit gives an installed web app (Add to Home Screen on iOS and iPadOS,
 * Add to Dock on macOS) its own storage container: cookies are copied at
 * install time, but OPFS, IndexedDB, and localStorage are not. Local data
 * created in a browser tab before installing therefore stays in the browser's
 * container, and the installed app starts empty. Chromium installed apps share
 * the installing profile's storage and do not fork.
 *
 * The guard covers both sides of that boundary. In a browser tab it watches
 * for local-only data — writes that do not replicate because the user has not
 * elected sync — and, while any exists, maintains a per-app flag cookie, the
 * one signal that survives installation. In a standalone launch whose local
 * storage has never been touched, that inherited cookie identifies the fork,
 * and the guard surfaces a notice naming where the data lives and how to move
 * it: back up or sync in the browser, then restore in the installed app.
 *
 * Safari caps script-set cookies at seven days, so the flag is refreshed on
 * every boot while data is at risk; a long gap between the last browser visit
 * and installation loses the flag and, with it, the post-install notice. The
 * pre-install warning in the install guidance does not depend on the cookie.
 *
 * Zero configuration is safe: in development the guard is inert, and the
 * framework renders a minimal default notice that apps may replace via the
 * optional `pwa` block of `defineLofiApp` and the `useStorageFork` Preact
 * hook.
 *
 * @module
 */

import { getLofiApp } from "./app.ts";
import { syncing } from "./config.ts";
import { anchorAppId } from "./data-sink.ts";
import type { RuntimeDiagnostics } from "./diagnostics.ts";
import type { InstallEnvironment } from "./pwa.ts";

/** The storage-container fork state exposed through the guard and the Preact hook. */
export type StorageForkState =
  /** No verdict: development mode, or the guard has not started. */
  | { state: "unarmed"; reason: "inactive" | "development" }
  /** Nothing to warn about: no local-only data, or writes replicate. */
  | { state: "idle" }
  /** This browsing context holds local-only data; installing on iOS forks it. */
  | { state: "browser-data-at-risk" }
  /** A standalone launch into a fresh container while the flag cookie is present. */
  | { state: "fork-detected"; message: string };

const forkDetectedMessage =
  "This installed app starts with its own empty storage — the data you created before " +
  "installing is still in Safari. Open the site in Safari, turn on sync or back up your " +
  "account there, then restore it here. Dismiss this to start fresh.";

/** The diagnostics fields the guard reads to recognize real write activity. */
export type StorageForkDiagnostics = Pick<
  RuntimeDiagnostics,
  "storageState" | "localWaitCalls" | "journaledPendingWrites" | "lastWriteDurability"
>;

/** The diagnostics feed the guard observes; the runtime supplies the default. */
export type StorageForkDiagnosticsSurface = {
  /** The current diagnostics snapshot. */
  get(): StorageForkDiagnostics;
  /** Subscribes to diagnostics changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
};

/** Injectable browser surfaces used to test the guard deterministically. */
export type StorageForkGuardDependencies = {
  readonly production?: () => boolean;
  readonly appId?: () => string;
  readonly storage?: () => Pick<Storage, "getItem" | "setItem"> | undefined;
  /** Every localStorage key in this container, for the freshness snapshot. */
  readonly storageKeys?: () => readonly string[];
  readonly readCookies?: () => string;
  readonly writeCookie?: (cookie: string) => void;
  /** The cookie `Path` attribute; defaults to the deployment base path. */
  readonly cookiePath?: () => string;
  readonly secureContext?: () => boolean;
  readonly environment?: () => Pick<
    InstallEnvironment,
    "displayModeStandalone" | "navigatorStandalone"
  >;
  readonly syncing?: () => boolean;
  /** The write-activity feed; defaults to the runtime's diagnostics, loaded lazily. */
  readonly diagnostics?: () => StorageForkDiagnosticsSurface;
  /** Whether any declared table holds a locally persisted row (pre-guard data). */
  readonly probeLocalRows?: () => Promise<boolean>;
  /** Target for cross-tab `storage` events; defaults to the window. */
  readonly storageEvents?: () => EventTarget | undefined;
};

/** The storage-container fork guard for one browsing context. */
export type StorageForkGuard = {
  /** Starts the guard once; later calls are no-ops. */
  start(): void;
  /** The current fork state snapshot. */
  getState(): StorageForkState;
  /** Subscribes to state changes; the listener runs immediately. */
  subscribe(listener: (state: StorageForkState) => void): () => void;
  /** Acknowledges a detected fork: clears the flag cookie and settles idle. */
  dismissFork(): void;
};

function defaultStorageKeys(): readonly string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function defaultCookiePath(): string {
  try {
    const base = new URL(import.meta.env.BASE_URL, document.location.origin);
    return base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  } catch {
    return "/";
  }
}

function defaultEnvironment(): Pick<
  InstallEnvironment,
  "displayModeStandalone" | "navigatorStandalone"
> {
  try {
    return {
      displayModeStandalone: matchMedia("(display-mode: standalone)").matches,
      navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
    };
  } catch {
    return { displayModeStandalone: false, navigatorStandalone: false };
  }
}

/** Creates an isolated guard, primarily for tests; boot uses the shared one. */
export function createStorageForkGuard(
  dependencies: StorageForkGuardDependencies = {},
): StorageForkGuard {
  const subscribers = new Set<(state: StorageForkState) => void>();
  let state: StorageForkState = { state: "unarmed", reason: "inactive" };
  let started = false;
  let probed = false;
  // In-memory marker fallback so a private-mode storage failure still warns
  // for the current document.
  let markerMemory = false;
  let lastCookieVerdict: boolean | null = null;

  const appId = () => dependencies.appId?.() ?? anchorAppId;
  const storage = () => {
    if (dependencies.storage) return dependencies.storage();
    try {
      return typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
      return undefined;
    }
  };
  const storageKeys = () => {
    try {
      return dependencies.storageKeys?.() ?? defaultStorageKeys();
    } catch {
      return [];
    }
  };
  const readCookies = () => {
    try {
      if (dependencies.readCookies) return dependencies.readCookies();
      return typeof document === "undefined" ? "" : document.cookie;
    } catch {
      return "";
    }
  };
  const writeCookie = (cookie: string) => {
    try {
      if (dependencies.writeCookie) dependencies.writeCookie(cookie);
      else if (typeof document !== "undefined") document.cookie = cookie;
    } catch {
      // A blocked cookie write must not affect a working runtime.
    }
  };
  const cookiePath = () => dependencies.cookiePath?.() ?? defaultCookiePath();
  const secureContext = () => dependencies.secureContext?.() ?? globalThis.isSecureContext === true;
  const environment = () => {
    try {
      return dependencies.environment?.() ?? defaultEnvironment();
    } catch {
      return { displayModeStandalone: false, navigatorStandalone: false };
    }
  };
  const syncingNow = () => {
    try {
      return dependencies.syncing?.() ?? syncing();
    } catch {
      return false;
    }
  };

  const markerKey = () => `lofi:local-data:${appId()}`;
  const cookieName = () => `lofi-fork-${appId().replace(/[^A-Za-z0-9_-]/g, "_")}`;

  const publish = (next: StorageForkState) => {
    state = next;
    for (const subscriber of subscribers) subscriber(state);
  };

  const hasMarker = () => {
    if (markerMemory) return true;
    try {
      return storage()?.getItem(markerKey()) === "1";
    } catch {
      return false;
    }
  };

  const setMarker = () => {
    markerMemory = true;
    try {
      storage()?.setItem(markerKey(), "1");
    } catch {
      // The in-memory fallback still covers this document.
    }
  };

  const cookiePresent = () =>
    readCookies().split(";").some((part) => part.trim().startsWith(`${cookieName()}=`));

  const cookieAttributes = () =>
    `Path=${cookiePath()}; SameSite=Lax${secureContext() ? "; Secure" : ""}`;

  const maintainCookie = (atRisk: boolean) => {
    if (lastCookieVerdict === atRisk) return;
    lastCookieVerdict = atRisk;
    writeCookie(
      atRisk
        ? `${cookieName()}=1; ${cookieAttributes()}; Max-Age=31536000`
        : `${cookieName()}=; ${cookieAttributes()}; Max-Age=0`,
    );
  };

  const evaluate = () => {
    // A detected fork stands until the user dismisses it: cookie maintenance
    // must not clear the inherited flag before the notice has been seen.
    if (state.state === "fork-detected") return;
    const atRisk = hasMarker() && !syncingNow();
    maintainCookie(atRisk);
    publish(atRisk ? { state: "browser-data-at-risk" } : { state: "idle" });
  };

  const observeDiagnostics = (
    surface: StorageForkDiagnosticsSurface,
    probeLocalRows: () => Promise<boolean>,
  ) => {
    const check = () => {
      if (hasMarker()) {
        evaluate();
        return;
      }
      const diagnostics = surface.get();
      const wrote = diagnostics.localWaitCalls > 0 ||
        diagnostics.journaledPendingWrites > 0 ||
        diagnostics.lastWriteDurability === "local" ||
        diagnostics.lastWriteDurability === "global";
      if (wrote) {
        setMarker();
        evaluate();
        return;
      }
      // Data written before the guard existed leaves no marker; one bounded
      // probe answers for it. Waiting for the open driver guarantees the
      // probe reuses the runtime rather than causing account creation.
      if (!probed && diagnostics.storageState === "persistent-driver-open") {
        probed = true;
        void probeLocalRows().then((found) => {
          if (found) {
            setMarker();
            evaluate();
          }
        }).catch(() => undefined);
      }
    };
    surface.subscribe(check);
    check();
  };

  const attachDiagnostics = () => {
    if (dependencies.diagnostics) {
      const probe = dependencies.probeLocalRows ?? (() => Promise.resolve(false));
      observeDiagnostics(dependencies.diagnostics(), probe);
      return;
    }
    void import("./runtime.ts").then((runtime) => {
      observeDiagnostics(
        { get: runtime.getRuntimeDiagnostics, subscribe: runtime.subscribeRuntimeDiagnostics },
        dependencies.probeLocalRows ?? runtime.hasAnyLocalRows,
      );
    }).catch(() => undefined);
  };

  const attachStorageEvents = () => {
    const target = dependencies.storageEvents
      ? dependencies.storageEvents()
      : (typeof window === "undefined" ? undefined : window);
    // Another tab electing sync or writing first data changes this tab's
    // verdict in place; every runtime key is suffixed with the app id.
    target?.addEventListener("storage", (event) => {
      const key = (event as StorageEvent).key;
      if (typeof key !== "string" || key.endsWith(`:${appId()}`)) evaluate();
    });
  };

  return {
    start() {
      if (started) return;
      started = true;
      if (!(dependencies.production?.() ?? import.meta.env.PROD)) {
        publish({ state: "unarmed", reason: "development" });
        return;
      }
      // The freshness snapshot must precede any runtime writes: a container
      // is fresh only if no lofi key for this app has ever been stored.
      const fresh = !storageKeys().some((key) =>
        key.startsWith("lofi:") && key.endsWith(`:${appId()}`)
      );
      const standalone = (() => {
        const env = environment();
        return env.displayModeStandalone || env.navigatorStandalone;
      })();
      attachStorageEvents();
      if (standalone && fresh && cookiePresent()) {
        publish({ state: "fork-detected", message: forkDetectedMessage });
      } else {
        evaluate();
      }
      attachDiagnostics();
    },
    getState: () => state,
    subscribe(listener) {
      subscribers.add(listener);
      listener(state);
      return () => subscribers.delete(listener);
    },
    dismissFork() {
      if (state.state !== "fork-detected") return;
      state = { state: "idle" };
      lastCookieVerdict = null;
      evaluate();
    },
  };
}

/** Shared guard used by boot and the optional Preact bindings. */
export const storageForkGuard: StorageForkGuard = createStorageForkGuard();

/** Returns the shared guard's current fork state snapshot. */
export function getStorageForkState(): StorageForkState {
  return storageForkGuard.getState();
}

/** Subscribes to shared fork state; returns an unsubscribe function. */
export function subscribeStorageFork(
  listener: (state: StorageForkState) => void,
): () => void {
  return storageForkGuard.subscribe(listener);
}

/** Acknowledges a detected fork on the shared guard. */
export function dismissStorageFork(): void {
  storageForkGuard.dismissFork();
}

/** One-line label for diagnostic surfaces (development inspector, DeviceStatus). */
export function describeStorageFork(state: StorageForkState): string {
  switch (state.state) {
    case "unarmed":
      return state.reason === "development" ? "not checked (development)" : "not checked";
    case "idle":
      return "no local-only data at risk";
    case "browser-data-at-risk":
      return "local-only data — not backed up";
    case "fork-detected":
      return "fresh install — previous data is in the browser";
  }
}

// ---------------------------------------------------------------------------
// Default notice: the zero-configuration surface for a detected fork. A plain
// DOM element (no UI framework) so it works in any app; authors opt out with
// `pwa: { forkNotice: "none" }` and render their own from useStorageFork.
// ---------------------------------------------------------------------------

const noticeClass = "lofi-storage-fork-banner";

function renderDefaultNotice(state: StorageForkState): void {
  const existing = document.querySelector(`.${noticeClass}`);
  if (state.state !== "fork-detected") {
    existing?.remove();
    return;
  }
  const notice = existing ?? document.createElement("div");
  notice.textContent = "";
  notice.className = noticeClass;
  notice.setAttribute("role", "alert");
  (notice as HTMLElement).style.cssText =
    "position:fixed;inset:auto 0 0 0;z-index:2147483000;display:flex;gap:0.75rem;" +
    "align-items:center;justify-content:center;flex-wrap:wrap;padding:0.75rem 1rem;" +
    "background:#1f2430;color:#fff;font:14px/1.4 system-ui,sans-serif;text-align:center;";
  const message = document.createElement("span");
  message.textContent = state.message;
  notice.append(message);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Dismiss";
  button.style.cssText =
    "padding:0.35rem 0.9rem;border:1px solid #fff;border-radius:0.4rem;background:none;" +
    "color:inherit;font:inherit;cursor:pointer;";
  button.addEventListener("click", () => storageForkGuard.dismissFork());
  notice.append(button);
  if (!existing) document.body.append(notice);
}

/**
 * Mounts the framework's minimal fork notice unless the app opted out.
 * Called once by boot; safe without a defined app (defaults apply).
 */
export function mountDefaultForkNotice(): void {
  if (typeof document === "undefined") return;
  let preference: "default" | "none" = "default";
  try {
    preference = getLofiApp().pwa?.forkNotice ?? "default";
  } catch {
    // No app definition yet; the safe default applies.
  }
  if (preference === "none") return;
  storageForkGuard.subscribe(renderDefaultNotice);
}
