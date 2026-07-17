# Desktop window controls overlay

Use this experimental recipe when a desktop productivity app has noncritical navigation that earns
the titlebar space. Window Controls Overlay is not Baseline and is currently limited to some desktop
browsers. The generated app remains fully usable in `standalone` mode without it.

## Manifest opt-in and fallback

Keep the portable fallback in `display` and put the experimental mode first in `display_override`:

```json
{
  "display": "standalone",
  "display_override": ["window-controls-overlay"]
}
```

The override matters only for an installed desktop app in a supporting browser. A user can toggle
the overlay, so feature presence never means it is visible. Existing installs may require a manifest
refresh, browser restart, or reinstall before a changed display mode takes effect.

## Collision-free layout

Let the browser-provided physical geometry define the usable titlebar area. Keep the ordinary header
as the default, then reposition only while the display mode is active:

```css
.app-titlebar {
  min-block-size: 3rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border-block-end: 1px solid CanvasText;
}

@media (display-mode: window-controls-overlay) {
  .app-titlebar {
    position: fixed;
    left: env(titlebar-area-x, 0px);
    top: env(titlebar-area-y, 0px);
    width: env(titlebar-area-width, 100%);
    height: env(titlebar-area-height, 3rem);
    min-block-size: 0;
    app-region: drag;
  }

  .app-titlebar :is(a, button, input, select, textarea) {
    app-region: no-drag;
  }

  main {
    padding-block-start: env(titlebar-area-height, 3rem);
  }
}

@media (display-mode: window-controls-overlay) and (max-width: 32rem) {
  .app-titlebar .noncritical-action {
    display: none;
  }
}

@media (forced-colors: active) {
  .app-titlebar {
    border-color: CanvasText;
  }
}
```

Do not assume controls are on the right: macOS, Windows, browser UI, RTL, zoom, and resizing can all
change the available physical rectangle. The `titlebar-area-*` variables already exclude system
window controls. Never position content outside their rectangle or cover system-critical controls.

Only noninteractive empty space should be draggable. Links, buttons, menus, inputs, and focus rings
must remain keyboard reachable and `no-drag`. Preserve a visible title and border in high-contrast
mode, do not communicate state by color alone, and remove noncritical actions before compressing
interactive targets in a narrow window.

## Runtime geometry

CSS should own layout. Observe geometry only when application state genuinely needs it:

```ts
import { observeWindowControlsOverlay } from "@nzip/lofi/recipes/window-controls-overlay";

const observer = observeWindowControlsOverlay({
  onGeometry({ visible, titlebarArea }) {
    document.documentElement.toggleAttribute("data-overlay-visible", visible);
    console.debug("available titlebar width", titlebarArea.width);
  },
});

// During component teardown:
observer.dispose();
```

The observer feature-detects the API, reports initial and changed geometry, and stops cleanly. The
standalone header remains the fallback when unsupported. Geometry events can fire rapidly while
resizing, so avoid synchronous layout reads/writes in the callback and coalesce expensive work.

Test installed and ordinary browser windows, overlay on/off, resize and zoom, controls on both
sides, LTR and RTL, narrow width, keyboard-only use, drag/no-drag regions, high contrast, offline
startup, manifest updates, and uninstall/reinstall.

## Tabbed display: no ship

Lofi does not expose `display_override: ["tabbed"]` or `tab_strip`. As of this evaluation, tabbed
mode remains an incubation proposal without a credible cross-browser installed-app test matrix. Its
home tab rules can also redirect ordinary same-document navigation into other application contexts,
which needs product-specific lifecycle testing. The manifest validator reports it as lacking a
tested lofi recipe. Continue using ordinary in-app document navigation, browser tabs, or separate
standalone windows until implementations and automation support make the semantics portable and
testable.

References:
[MDN Window Controls Overlay API](https://developer.mozilla.org/en-US/docs/Web/API/Window_Controls_Overlay_API),
[WICG Window Controls Overlay draft](https://wicg.github.io/window-controls-overlay/), and the
[WICG tabbed-mode explainer](https://wicg.github.io/manifest-incubations/tabbed-mode-explainer.html).
