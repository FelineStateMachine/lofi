/// <reference path="../env.d.ts" />

import type { DbConfig } from "jazz-tools";
import { referenceApp } from "../app.ts";

const LOCAL_APP_ID = "00000000-0000-0000-0000-00000000f153";
const configuredAppId = typeof __LOFI_JAZZ_APP_ID__ === "string" ? __LOFI_JAZZ_APP_ID__ : "";
const configuredServerUrl = typeof __LOFI_JAZZ_SERVER_URL__ === "string"
  ? __LOFI_JAZZ_SERVER_URL__
  : "";
export const appId = configuredAppId || LOCAL_APP_ID;
export const serverUrl = configuredServerUrl || undefined;

export function databaseConfig(secret: string): DbConfig {
  return {
    appId,
    ...(serverUrl ? { serverUrl } : {}),
    secret,
    driver: { type: "persistent", dbName: `${referenceApp.databaseName}-${appId}` },
  };
}
