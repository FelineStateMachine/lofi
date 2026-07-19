// Package-owned environment and adapter configuration.

import type { DbConfig, IncompatibleBrowserBrokerConfigurationHandler } from "jazz-tools";
import { getLofiApp } from "./app.ts";
import { anchorAppId, configuredServerUrl, readDeclaredSink } from "./data-sink.ts";

/**
 * The device-local anchor app id: storage keys, the account secret store, and
 * the local database namespace key off this value, so state written before a
 * sink is declared survives the declaration. See `data-sink.ts` for how it is
 * derived.
 */
export const appId = anchorAppId;

/** The sync location currently in effect and where it came from. */
export type ActiveSink = {
  /** `declared` is a runtime-declared sink; `default` is the compiled managed app. */
  source: "declared" | "default";
  appId: string;
  serverUrl: string;
  label?: string;
  /** Present when the enrolled ticket is possession-bound to this device. */
  pop?: { ticketId: string };
};

/**
 * Resolves the sync location in effect: a runtime-declared sink wins, the
 * compiled managed app (when the deployment has one) is the default, and
 * `null` means this device is local-only until the user declares one.
 */
export function activeSink(): ActiveSink | null {
  const declared = readDeclaredSink();
  if (declared) {
    return {
      source: "declared",
      appId: declared.appId,
      serverUrl: declared.serverUrl,
      ...(declared.label ? { label: declared.label } : {}),
      ...(declared.pop ? { pop: declared.pop } : {}),
    };
  }
  return configuredServerUrl
    ? { source: "default", appId: anchorAppId, serverUrl: configuredServerUrl }
    : null;
}

/** The server URL of the sync location in effect, if any. */
export function activeServerUrl(): string | undefined {
  return activeSink()?.serverUrl;
}

/** The Jazz app id of the sync location in effect, falling back to the anchor. */
export function activeAppId(): string {
  return activeSink()?.appId ?? anchorAppId;
}

/** Whether a sync location exists (declared or compiled), so sync/backup is possible. */
export function syncAvailable(): boolean {
  return activeSink() !== null;
}

const syncElectionKey = `lofi:sync-elected:${appId}`;

/**
 * Whether the user on this device has elected to back up and sync this account.
 * First boot is local-only; the account only reaches the network once the user
 * opts in (see `session.ts`), so nothing leaves the device by default.
 */
export function syncElected(): boolean {
  if (!syncAvailable() || typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(syncElectionKey) === "1";
  } catch {
    return false;
  }
}

/** Records (or clears) the sync election. Ignored when no sync location exists. */
export function setSyncElected(elected: boolean): void {
  if (!syncAvailable() || typeof localStorage === "undefined") return;
  try {
    if (elected) localStorage.setItem(syncElectionKey, "1");
    else localStorage.removeItem(syncElectionKey);
  } catch {
    // A private-mode storage failure must not break account setup.
  }
}

/** Whether writes actually replicate right now: a sync location exists *and* is elected. */
export function syncing(): boolean {
  return syncAvailable() && syncElected();
}

export function databaseConfig(
  secret: string,
  accountNamespace: string,
  mode: "local" | "managed" = syncing() ? "managed" : "local",
  connect = mode === "managed" && syncing(),
  onIncompatibleBrowserBrokerConfiguration: IncompatibleBrowserBrokerConfigurationHandler =
    () => {},
  serverUrlOverride?: string,
): DbConfig {
  const app = getLofiApp();
  const sink = activeSink();
  // The local tier stays on the anchor so first-boot data is always found; the
  // managed tier belongs to the active sink's store, so a declared sink gets
  // its own database namespace and connection identity.
  const connectionAppId = mode === "managed" ? (sink?.appId ?? appId) : appId;
  return {
    appId: connectionAppId,
    // The same local-first secret opens the same account whether or not a server
    // is attached, so electing to sync later preserves all existing data.
    // A possession-bound sink connects through its token URL, minted by the
    // proof-of-possession exchange each boot; everything else uses the sink
    // URL verbatim.
    ...(connect && sink ? { serverUrl: serverUrlOverride ?? sink.serverUrl } : {}),
    secret,
    driver: {
      type: "persistent",
      dbName: `${app.databaseName}-${connectionAppId}-${accountNamespace}-${mode}`,
    },
    onIncompatibleBrowserBrokerConfiguration,
  };
}
