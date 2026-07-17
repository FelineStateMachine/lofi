import { render } from "npm:preact-render-to-string@6.7.0";
import type { PwaController, PwaState } from "../runtime/pwa.ts";
import { PwaActions, pwaFailureMessage } from "./PwaActions.tsx";

function controller(state: PwaState): PwaController {
  return {
    getState: () => state,
    subscribe(subscriber) {
      subscriber(state);
      return () => undefined;
    },
    requestInstall: () => Promise.resolve(state.install),
    applyUpdate: () => true,
    initialize: () => undefined,
  };
}

function renderState(state: PwaState): string {
  return render(<PwaActions controller={controller(state)} />);
}

Deno.test("PwaActions renders a Chromium action only while the prompt is available", () => {
  const available = renderState({ worker: "ready", install: "available" });
  const dismissed = renderState({ worker: "ready", install: "dismissed" });
  if (!available.includes("Install app")) throw new Error("install action was omitted");
  if (dismissed.includes("Install app")) throw new Error("install action outlived its prompt");
  if (!dismissed.includes("Installation dismissed")) {
    throw new Error("dismissed outcome was hidden");
  }
});

Deno.test("PwaActions renders complete iOS Add to Home Screen guidance", () => {
  const html = renderState({ worker: "ready", install: "manual-ios" });
  for (const step of ["Open the Share menu.", "Choose Add to Home Screen.", "Confirm Add."]) {
    if (!html.includes(step)) throw new Error(`iOS guidance omitted: ${step}`);
  }
  if (/unavailable in (?:the )?EU/i.test(html)) throw new Error("obsolete EU guidance returned");
});

Deno.test("PwaActions renders the waiting-worker update action", () => {
  const html = renderState({ worker: "update-available", install: "unavailable" });
  if (!html.includes("Update app")) throw new Error("update action was omitted");
});

Deno.test("actionable PWA failure messages are fixed, useful, and non-secret", () => {
  for (const code of ["registration", "installation", "precache", "runtime-cache"] as const) {
    const message = pwaFailureMessage(code);
    if (!/(Reload|Reconnect)/.test(message)) throw new Error(`${code} lacks an action`);
    const html = renderState({
      worker: "failed",
      install: "unavailable",
      failure: { code, message: "secret-value-must-not-render" },
    });
    if (!html.includes(message) || html.includes("secret-value")) {
      throw new Error(`${code} failure rendering is not safely actionable`);
    }
  }
});
