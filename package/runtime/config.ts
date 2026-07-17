// Package-owned environment and adapter configuration.

import type { DbConfig, IncompatibleBrowserBrokerConfigurationHandler } from "jazz-tools";
import { getLofiApp } from "./app.ts";

declare const __LOFI_JAZZ_APP_ID__: string;
declare const __LOFI_JAZZ_SERVER_URL__: string;

const LOCAL_APP_ID = "00000000-0000-0000-0000-00000000f153";
const configuredAppId = typeof __LOFI_JAZZ_APP_ID__ === "string" ? __LOFI_JAZZ_APP_ID__ : "";
const configuredServerUrl = typeof __LOFI_JAZZ_SERVER_URL__ === "string"
  ? __LOFI_JAZZ_SERVER_URL__
  : "";
export const appId = configuredAppId || LOCAL_APP_ID;
export const serverUrl = configuredServerUrl || undefined;

/** Whether this deployment has a managed Jazz app, so sync/backup is possible. */
export const syncAvailable = Boolean(serverUrl);

const syncElectionKey = `lofi:sync-elected:${appId}`;

/**
 * Whether the user on this device has elected to back up and sync this account.
 * First boot is local-only; the account only reaches the network once the user
 * opts in (see `session.ts`), so nothing leaves the device by default.
 */
export function syncElected(): boolean {
  if (!syncAvailable || typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(syncElectionKey) === "1";
  } catch {
    return false;
  }
}

/** Records (or clears) the sync election. Ignored when no Jazz app is configured. */
export function setSyncElected(elected: boolean): void {
  if (!syncAvailable || typeof localStorage === "undefined") return;
  try {
    if (elected) localStorage.setItem(syncElectionKey, "1");
    else localStorage.removeItem(syncElectionKey);
  } catch {
    // A private-mode storage failure must not break account setup.
  }
}

/** Whether writes actually replicate right now: a Jazz app is configured *and* elected. */
export function syncing(): boolean {
  return syncAvailable && syncElected();
}

export function databaseConfig(
  secret: string,
  accountNamespace: string,
  mode: "local" | "managed" = syncing() ? "managed" : "local",
  connect = mode === "managed" && syncing(),
  onIncompatibleBrowserBrokerConfiguration: IncompatibleBrowserBrokerConfigurationHandler =
    () => {},
): DbConfig {
  const app = getLofiApp();
  return {
    appId,
    // The same local-first secret opens the same account whether or not a server
    // is attached, so electing to sync later preserves all existing data.
    ...(connect && serverUrl ? { serverUrl } : {}),
    secret,
    driver: {
      type: "persistent",
      dbName: `${app.databaseName}-${appId}-${accountNamespace}-${mode}`,
    },
    onIncompatibleBrowserBrokerConfiguration,
  };
}
