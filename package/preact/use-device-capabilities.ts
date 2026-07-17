import { useCallback, useEffect, useState } from "preact/hooks";
// Package-owned Preact capability hook.
import {
  type DeviceCapabilityReport,
  readDeviceCapabilityReport,
  requestPersistentStorage,
} from "../runtime/device-capabilities.ts";

export type DeviceCapabilitiesHook = {
  report: DeviceCapabilityReport | null;
  requestPersistence(): Promise<void>;
};

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
