import { render } from "npm:preact-render-to-string@6.7.0";
import type { PwaController, PwaState } from "../runtime/pwa.ts";
import type { StorageForkState } from "../runtime/storage-fork.ts";
import { PwaActions, pwaFailureMessage } from "./PwaActions.tsx";
import type { StorageForkSurface } from "./use-storage-fork.ts";

function controller(state: PwaState): PwaController {
  return {
    getState: () => state,
    subscribe(subscriber) {
      subscriber(state);
      return () => undefined;
    },
    requestInstall: () => Promise.resolve(state.install),
    checkForUpdate: () => Promise.resolve(false),
    applyUpdate: () => true,
    initialize: () => undefined,
  };
}

function fork(state: StorageForkState): StorageForkSurface {
  return {
    getState: () => state,
    subscribe(subscriber) {
      subscriber(state);
      return () => undefined;
    },
  };
}

function renderState(state: PwaState, forkState?: StorageForkState): string {
  return render(
    <PwaActions
      controller={controller(state)}
      fork={forkState ? fork(forkState) : undefined}
    />,
  );
}

Deno.test("PwaActions renders a Chromium action only while the prompt is available", () => {
  const available = renderState({ worker: "ready", install: "available", update: "idle" });
  const dismissed = renderState({ worker: "ready", install: "dismissed", update: "idle" });
  if (!available.includes("Install app")) throw new Error("install action was omitted");
  if (dismissed.includes("Install app")) throw new Error("install action outlived its prompt");
  if (!dismissed.includes("Installation dismissed")) {
    throw new Error("dismissed outcome was hidden");
  }
});

Deno.test("PwaActions renders complete iOS Add to Home Screen guidance", () => {
  const html = renderState({ worker: "ready", install: "manual-ios", update: "idle" });
  for (const step of ["Open the Share menu.", "Choose Add to Home Screen.", "Confirm Add."]) {
    if (!html.includes(step)) throw new Error(`iOS guidance omitted: ${step}`);
  }
  if (/unavailable in (?:the )?EU/i.test(html)) throw new Error("obsolete EU guidance returned");
});

Deno.test("PwaActions leads iOS guidance with the fork warning while data is at risk", () => {
  const html = renderState(
    { worker: "ready", install: "manual-ios", update: "idle" },
    { state: "browser-data-at-risk" },
  );
  const warning = html.indexOf("stays in Safari and is not carried over");
  const steps = html.indexOf("Open the Share menu.");
  if (warning === -1) throw new Error("the iOS fork warning was omitted");
  if (steps === -1 || warning > steps) {
    throw new Error("the fork warning does not precede the install steps");
  }
});

Deno.test("PwaActions omits the fork warning without local-only data", () => {
  const html = renderState(
    { worker: "ready", install: "manual-ios", update: "idle" },
    { state: "idle" },
  );
  if (html.includes("pwa-fork-warning")) throw new Error("the fork warning rendered without risk");
});

Deno.test("PwaActions never warns about forking outside the iOS branch", () => {
  for (const install of ["available", "manual-browser"] as const) {
    const html = renderState(
      { worker: "ready", install, update: "idle" },
      { state: "browser-data-at-risk" },
    );
    if (html.includes("pwa-fork-warning")) {
      throw new Error(`the fork warning rendered for ${install}, which does not fork storage`);
    }
  }
});

Deno.test("PwaActions renders truthful generic manual-install guidance", () => {
  const html = renderState({ worker: "ready", install: "manual-browser", update: "idle" });
  if (!html.includes("No in-page install button is available right now")) {
    throw new Error("missing prompt limitation");
  }
  if (!html.includes("if offered")) throw new Error("manual guidance invented availability");
});

Deno.test("PwaActions renders every active update phase", () => {
  const checking = renderState({ worker: "ready", install: "installed", update: "checking" });
  const installing = renderState({ worker: "ready", install: "installed", update: "installing" });
  const ready = renderState({ worker: "ready", install: "installed", update: "ready" });
  const applying = renderState({ worker: "ready", install: "installed", update: "applying" });
  if (!checking.includes("Checking for updates")) throw new Error("checking state was omitted");
  if (!installing.includes("Installing update")) throw new Error("installing state was omitted");
  if (!ready.includes("Update app")) throw new Error("waiting-worker action was omitted");
  if (!applying.includes("Applying update")) throw new Error("applying state was omitted");
});

Deno.test("PwaActions distinguishes unsupported installation", () => {
  const html = renderState({ worker: "unsupported", install: "unsupported", update: "idle" });
  if (!html.includes("not supported in this browser or browsing context")) {
    throw new Error("unsupported environment was hidden");
  }
});

Deno.test("actionable PWA failure messages are fixed, useful, and non-secret", () => {
  for (
    const code of [
      "registration",
      "installation",
      "install-prompt",
      "update-check",
      "precache",
      "runtime-cache",
    ] as const
  ) {
    const message = pwaFailureMessage(code);
    if (!/(Reload|Reconnect|browser menu)/i.test(message)) {
      throw new Error(`${code} lacks an action`);
    }
    const html = renderState({
      worker: "failed",
      install: "unsupported",
      update: code === "update-check" ? "failed" : "idle",
      failure: { code, message: "secret-value-must-not-render" },
    });
    if (!html.includes(message) || html.includes("secret-value")) {
      throw new Error(`${code} failure rendering is not safely actionable`);
    }
  }
});
