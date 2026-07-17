import { useCallback, useEffect, useState } from "preact/hooks";
// Package-owned Preact capability hook.
import {
  type DeviceCapabilityReport,
  readDeviceCapabilityReport,
  requestPersistentStorage,
} from "../runtime/device-capabilities.ts";
export type { DeviceCapabilityReport } from "../runtime/device-capabilities.ts";

/** State returned by {@link useDeviceCapabilities}. */
export type DeviceCapabilitiesHook = {
  report: DeviceCapabilityReport | null;
  requestPersistence(): Promise<void>;
};

/** Reads browser capabilities and exposes an explicit persistence request. */
export function useDeviceCapabilities(): DeviceCapabilitiesHook {
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
