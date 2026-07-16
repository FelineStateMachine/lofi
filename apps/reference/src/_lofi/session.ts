/**
 * Account session for the `device-passkey` identity: the glue between the
 * WebAuthn primitive in `auth.ts` and the runtime's account secret.
 *
 * "The key is the account", so signing in *is* deriving the account secret from
 * the passkey (a user-gesture WebAuthn ceremony), caching it, and recreating the
 * runtime so data opens. Signing out forgets the cached secret on this device —
 * it never deletes the passkey and makes no recovery claim. When identity is
 * `device-local`, there is nothing to sign into and {@link readSession} always
 * reports signed-in.
 *
 * The small, honest UI that drives this lives in author space
 * (`src/islands/AccountGate.tsx`) — this module is the framework side.
 *
 * @module
 */

import { BrowserAuthSecretStore } from "jazz-tools";
import { referenceApp } from "../app.ts";
import { appId, serverUrl } from "./config.ts";
import {
  type AuthCapability,
  AuthError,
  deriveAccount,
  type DeviceCredential,
  enrollDeviceCredential,
  getAuthCapability,
} from "./auth.ts";
import { recreateRuntime, runtimeRecreatedEvent, shutdownRuntime } from "./runtime.ts";

/** A signed-in identity, remembered locally so the status UI can name the key. */
export type AccountProfile = {
  /** The relying-party id (origin hostname) the account's passkey is bound to. */
  rpId: string;
  /** Whether the passkey roams across devices (backup-eligible). */
  portable: boolean;
  /** The nickname the passkey was enrolled with. */
  label: string;
};

/** A snapshot of the account gate: what to render and what the client can do. */
export type Session = {
  /** The configured identity model (`app.ts`). */
  identity: "device-local" | "device-passkey";
  /** Whether this identity requires a passkey sign-in before data opens. */
  requiresPasskey: boolean;
  /** Whether an account secret is available (data can open). */
  signedIn: boolean;
  /** Whether writes replicate to a managed account (cloud configured). */
  syncing: boolean;
  /** Device/browser/origin capability, or `null` for `device-local`. */
  capability: AuthCapability | null;
  /** The remembered account on this device, if any. */
  profile: AccountProfile | null;
};

const profileKey = `lofi:account-profile:${appId}`;

function loadProfile(): AccountProfile | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(profileKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AccountProfile>;
    if (typeof parsed?.rpId !== "string") return null;
    return {
      rpId: parsed.rpId,
      portable: parsed.portable === true,
      label: typeof parsed.label === "string" ? parsed.label : referenceApp.name,
    };
  } catch {
    return null;
  }
}

function saveProfile(profile: AccountProfile): void {
  try {
    localStorage?.setItem(profileKey, JSON.stringify(profile));
  } catch {
    // A private-mode storage failure must not fail the sign-in itself.
  }
}

function clearProfile(): void {
  try {
    localStorage?.removeItem(profileKey);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/** Reads the current session without prompting for any credential. */
export async function readSession(): Promise<Session> {
  const identity = referenceApp.identity;
  const syncing = Boolean(serverUrl);
  if (identity !== "device-passkey") {
    return {
      identity,
      requiresPasskey: false,
      signedIn: true,
      syncing,
      capability: null,
      profile: null,
    };
  }
  const [capability, cached] = await Promise.all([
    getAuthCapability(),
    BrowserAuthSecretStore.loadSecret({ appId }),
  ]);
  return {
    identity,
    requiresPasskey: true,
    signedIn: Boolean(cached),
    syncing,
    capability,
    profile: loadProfile(),
  };
}

// Caches the derived secret, remembers the credential, and reopens the runtime
// so every consumer reconnects against the now-available account.
async function activate(
  credential: DeviceCredential,
  secret: string,
  label: string,
): Promise<Session> {
  await BrowserAuthSecretStore.saveSecret(secret, { appId });
  saveProfile({ rpId: credential.rpId, portable: credential.portable, label });
  await recreateRuntime();
  globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
  return await readSession();
}

/**
 * Registers a brand-new passkey and derives the account it represents. Use this
 * for a first-time account; the `label` names the key in the user's password
 * manager. Prefer a portable (roaming) passkey so the account reaches other
 * devices — {@link Session.profile} reports which kind was created.
 */
export async function createPasskeyAccount(label: string = referenceApp.name): Promise<Session> {
  // create() reports backup-eligibility from its attestation; the follow-up
  // derive uses PRF (a get()), which is the portable way to obtain the secret.
  const enrolled = await enrollDeviceCredential({ label });
  const account = await deriveAccount();
  return await activate(
    { ...account.credential, portable: enrolled.portable },
    account.secret,
    label,
  );
}

/**
 * Signs in with an existing passkey in a single ceremony — the key reconstructs
 * the same account it always derives. Throws `prf-unavailable` if the client
 * cannot do PRF and `cancelled` if the user dismisses the prompt.
 */
export async function signInWithPasskey(): Promise<Session> {
  const account = await deriveAccount();
  const label = loadProfile()?.label ?? referenceApp.name;
  return await activate(account.credential, account.secret, label);
}

/**
 * Forgets the cached account on this device and returns to the signed-out gate.
 * The passkey itself is untouched — signing in again re-derives the same
 * account. There is no server-side account, so nothing else is revoked.
 */
export async function signOut(): Promise<Session> {
  await shutdownRuntime();
  await BrowserAuthSecretStore.clearSecret({ appId });
  clearProfile();
  globalThis.dispatchEvent(new Event(runtimeRecreatedEvent));
  return await readSession();
}

/** True when an error means "no account secret yet" — render the sign-in gate. */
export function isSignedOut(error: unknown): boolean {
  return error instanceof AuthError && error.code === "credential-missing";
}
