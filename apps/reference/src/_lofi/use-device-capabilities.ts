import { useCallback, useEffect, useState } from "preact/hooks";
import {
  type DeviceCapabilityReport,
  readDeviceCapabilityReport,
  requestPersistentStorage,
} from "./device-capabilities.ts";

export function useDeviceCapabilities() {
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
