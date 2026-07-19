import { useEffect, useState } from "preact/hooks";
import { useBootProgress, usePendingWrites } from "@nzip/lofi/preact";

/**
 * Live facts in the top bar, read from the runtime and the browser: storage
 * state, network state, and writes waiting to sync. Pull the cable and the
 * network fact flips while the board keeps working; that behavior is the
 * demo's whole argument, so it is measured, not asserted.
 */
export default function StatusStrip() {
  const boot = useBootProgress();
  const pending = usePendingWrites();
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    globalThis.addEventListener("online", update);
    globalThis.addEventListener("offline", update);
    return () => {
      globalThis.removeEventListener("online", update);
      globalThis.removeEventListener("offline", update);
    };
  }, []);

  const storage = boot.phase === "ready"
    ? "open"
    : boot.phase === "failed"
    ? "failed"
    : boot.phase === "downloading"
    ? "downloading"
    : "opening";

  return (
    <p class="status-strip" role="status">
      <span data-fact="storage">on-device storage: {storage}</span>
      <span data-fact="network" data-online={online ? "yes" : "no"}>
        network: {online ? "online" : "offline"}
      </span>
      <span data-fact="pending">unsynced writes: {pending.count}</span>
    </p>
  );
}
