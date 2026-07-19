import { useCallback, useEffect, useState } from "preact/hooks";
// Package-owned Preact capability hook.
import {
  type DeviceCapabilityReport,
  readDeviceCapabilityReport,
  requestPersistentStorage,
} from "../runtime/device-capabilities.ts";
export type { DeviceCapabilityReport } from "../runtime/device-capabilities.ts";

/** State returned by {@link useDeviceCapabilities}. */
export type DeviceCapabilitiesState = {
  /** The capability report, or `null` while the initial read is in flight. */
  report: DeviceCapabilityReport | null;
  /** Requests eviction protection from the browser, then refreshes the report. */
  requestPersistence(): Promise<void>;
};

/**
 * Reads the browser's device capabilities once on mount and exposes an
 * explicit persistence request that refreshes the report with the browser's
 * verdict.
 *
 * @example
 * ```tsx
 * import { useDeviceCapabilities } from "@nzip/lofi/preact";
 *
 * const { report, requestPersistence } = useDeviceCapabilities();
 * if (!report) return <p>Checking device capabilities…</p>;
 * ```
 *
 * @returns The capability report and the persistence request action.
 */
export function useDeviceCapabilities(): DeviceCapabilitiesState {
  const [report, setReport] = useState<DeviceCapabilityReport | null>(null);
  useEffect(() => {
    let active = true;
    void readDeviceCapabilityReport().then((next) => {
      if (active) setReport(next);
    });
    return () => {
      active = false;
    };
  }, []);
  const requestPersistence = useCallback(async () => {
    const next = await requestPersistentStorage();
    setReport(next);
  }, []);
  return { report, requestPersistence };
}
