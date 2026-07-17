import {
  observeWindowControlsOverlay,
  type WindowControlsOverlayClient,
  type WindowControlsOverlayGeometry,
} from "./window-controls-overlay.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("window controls observer reports initial and changed geometry", () => {
  let listener: EventListener | undefined;
  let visible = false;
  let rect = { x: 0, y: 0, width: 640, height: 32 };
  const client: WindowControlsOverlayClient = {
    get visible() {
      return visible;
    },
    getTitlebarAreaRect: () => rect,
    addEventListener: (_type, next) => listener = next,
    removeEventListener: (_type, next) => {
      if (listener === next) listener = undefined;
    },
  };
  const values: WindowControlsOverlayGeometry[] = [];
  const observer = observeWindowControlsOverlay({
    client,
    onGeometry: (value) => values.push(value),
  });
  assert(observer.supported, "valid API was reported unsupported");
  assert(values[0]?.titlebarArea.width === 640, "initial geometry was not delivered");
  visible = true;
  rect = { x: 72, y: 0, width: 480, height: 40 };
  listener?.(new Event("geometrychange"));
  assert(
    values[1]?.visible && values[1].titlebarArea.x === 72,
    "changed geometry was not delivered",
  );
  observer.dispose();
  listener?.(new Event("geometrychange"));
  assert(values.length === 2, "disposed observer received geometry");
});

Deno.test("window controls observer preserves unsupported standalone fallback", () => {
  let called = false;
  const observer = observeWindowControlsOverlay({ onGeometry: () => called = true });
  assert(!observer.supported, "missing API was reported supported");
  assert(!called, "unsupported API invented geometry");
});

Deno.test("window controls observer bounds malformed browser geometry", () => {
  const values: WindowControlsOverlayGeometry[] = [];
  const client: WindowControlsOverlayClient = {
    visible: true,
    getTitlebarAreaRect: () => ({
      x: -1,
      y: Number.NaN,
      width: Number.POSITIVE_INFINITY,
      height: 30,
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  observeWindowControlsOverlay({ client, onGeometry: (value) => values.push(value) });
  assert(
    JSON.stringify(values[0]?.titlebarArea) ===
      JSON.stringify({ x: 0, y: 0, width: 0, height: 30 }),
    "malformed geometry escaped",
  );
});
