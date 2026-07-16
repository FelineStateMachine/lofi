import { useCallback, useEffect, useState } from "preact/hooks";
import { referenceApp } from "../app.ts";
import { AuthError } from "../_lofi/auth.ts";
import {
  createPasskeyAccount,
  readSession,
  type Session,
  signInWithPasskey,
  signOut,
} from "../_lofi/session.ts";

/**
 * Author-owned auth example. With `identity: "device-passkey"` (the default),
 * the passkey *is* the account: signing in derives the Jazz account secret from
 * the key, so the same passkey opens the same data on every device it reaches.
 *
 * This whole island is one pattern — gate the app on a user-gesture sign-in and
 * show which key you are signed in with. It uses only the primitives in
 * `src/_lofi/session.ts`; nothing under `src/_lofi/` needs to change. Delete it
 * (and set `identity: "device-local"`) if you do not want passkey accounts.
 */

// Turns an AuthError code into a sentence a person can act on.
function describe(error: unknown): string {
  if (error instanceof AuthError) {
    switch (error.code) {
      case "cancelled":
        return "Passkey prompt dismissed. Try again when you are ready.";
      case "prf-unavailable":
        return "This browser or key cannot derive an account (no WebAuthn PRF). Try a platform passkey in a current browser.";
      case "origin-rejected":
        return error.message;
      case "unsupported":
        return "This browser does not support passkeys.";
      case "credential-missing":
        return "No passkey was returned. Try again, or create an account.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export default function AccountGate() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<"create" | "signin" | "signout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The nickname the user gives their passkey — it becomes the credential's name
  // in their password manager, so they can tell which account a key unlocks.
  const [label, setLabel] = useState("");

  useEffect(() => {
    let active = true;
    void readSession().then((next) => {
      if (active) setSession(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const run = useCallback(
    (kind: "create" | "signin" | "signout", action: () => Promise<Session>) => {
      setBusy(kind);
      setError(null);
      void action().then((next) => {
        setSession(next);
      }, (cause) => {
        setError(describe(cause));
      }).finally(() => setBusy(null));
    },
    [],
  );

  // Nothing to sign into under device-local identity; DeviceStatus reports it.
  if (!session || !session.requiresPasskey) return null;

  const { signedIn, syncing, capability, profile } = session;
  const prf = capability?.prf ?? "unknown";
  const origin = capability?.origin;
  const webAuthn = capability?.webAuthn ?? false;
  const prfBlocked = prf === "unavailable";
  const disabled = busy !== null || !webAuthn;

  if (signedIn) {
    return (
      <section class="account account-in" aria-labelledby="account-title">
        <header>
          <p class="eyebrow">Account</p>
          <h2 id="account-title">Signed in</h2>
        </header>
        <dl>
          <div>
            <dt>Key</dt>
            <dd>{profile?.label ?? "passkey"}</dd>
          </div>
          <div>
            <dt>Bound to</dt>
            <dd>{profile?.rpId ?? origin?.rpId ?? "this origin"}</dd>
          </div>
          <div>
            <dt>Portability</dt>
            <dd>
              {profile
                ? (profile.portable ? "roams across your devices" : "this device only")
                : "unknown"}
            </dd>
          </div>
          <div>
            <dt>Sync</dt>
            <dd>{syncing ? "syncing to your account" : "local-only"}</dd>
          </div>
        </dl>
        <button
          type="button"
          class="account-secondary"
          disabled={busy !== null}
          onClick={() => run("signout", signOut)}
        >
          {busy === "signout" ? "Signing out…" : "Sign out"}
        </button>
        <p>
          Enable passkey identity in your own app in three steps: (1) set{" "}
          <code>identity: "device-passkey"</code> in <code>src/app.ts</code>{" "}
          (the default); (2) list your permanent hostname(s) in <code>credentialOrigins</code>{" "}
          before shipping — leave it empty and the served origin is trusted; (3) render this{" "}
          <code>AccountGate</code> island and drive sign-in with <code>createPasskeyAccount</code> /
          {" "}
          <code>signInWithPasskey</code> from <code>src/_lofi/session.ts</code>.
        </p>
      </section>
    );
  }

  return (
    <section class="account account-out" aria-labelledby="account-title">
      <header>
        <p class="eyebrow">Account</p>
        <h2 id="account-title">Sign in with a passkey</h2>
      </header>
      <p>
        Your passkey is your account. Create one, or sign in with an existing one — the same key
        reaches the same data on every device it can.
      </p>
      <div class="account-field">
        <label for="passkey-label">Name this passkey</label>
        <input
          id="passkey-label"
          value={label}
          onInput={(event) => setLabel(event.currentTarget.value)}
          placeholder={referenceApp.name}
          autocomplete="off"
          disabled={busy !== null}
        />
        <p class="account-note">Shown in your password manager. Defaults to the app name.</p>
      </div>
      <div class="account-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={() => run("create", () => createPasskeyAccount(label.trim() || undefined))}
        >
          {busy === "create" ? "Creating…" : "Create passkey account"}
        </button>
        <button
          type="button"
          class="account-secondary"
          disabled={disabled}
          onClick={() => run("signin", signInWithPasskey)}
        >
          {busy === "signin" ? "Signing in…" : "Sign in with existing passkey"}
        </button>
      </div>
      {error && <p class="account-error" role="alert">{error}</p>}
      <dl class="account-caps">
        <div>
          <dt>Passkeys</dt>
          <dd>{webAuthn ? "supported" : "unsupported in this browser"}</dd>
        </div>
        <div>
          <dt>PRF (account derivation)</dt>
          <dd>
            {prf === "available"
              ? "available"
              : prf === "not-reported"
              ? "not reported — will be tried"
              : prf === "unavailable"
              ? "unavailable"
              : "unknown until you try"}
          </dd>
        </div>
        {origin && (
          <div>
            <dt>Origin ({origin.rpId || "unknown"})</dt>
            <dd>{origin.status}{origin.status !== "stable" ? ` — ${origin.action}` : ""}</dd>
          </div>
        )}
      </dl>
      {prfBlocked && (
        <p class="account-note">
          PRF is unavailable here, so account derivation cannot run — sign-in will report it rather
          than invent a key.
        </p>
      )}
      {origin?.status === "unverified" && (
        <p class="account-note">
          This origin is trusted by default so the app works wherever it is served, but a passkey
          enrolled here breaks if the host changes. Pin a permanent host in{" "}
          <code>credentialOrigins</code> (in <code>src/app.ts</code>) before shipping.
        </p>
      )}
    </section>
  );
}
