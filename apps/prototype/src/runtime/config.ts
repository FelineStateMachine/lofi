/// <reference path="../env.d.ts" />

import type { DbConfig } from "jazz-tools";

const LOCAL_APP_ID = "00000000-0000-0000-0000-00000000f153";
export const appId = import.meta.env?.VITE_JAZZ_APP_ID ?? LOCAL_APP_ID;
export const serverUrl = import.meta.env?.VITE_JAZZ_SERVER_URL;

export function databaseConfig(secret: string): DbConfig {
  return {
    appId,
    ...(serverUrl ? { serverUrl } : {}),
    secret,
    driver: { type: "persistent", dbName: `lofi-prototype-${appId}` },
  };
}
