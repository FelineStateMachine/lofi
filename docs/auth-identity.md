# The key is the account

lofi's default identity model: **a passkey _is_ the account.** The Jazz account secret is derived
from the credential, so the account lives wherever the key lives — and moves between devices exactly
as far as the key does.

This is the default (`identity: "device-passkey"` in `src/app.ts`). Set `identity: "device-local"`
for a random, device-bound account with no sign-in (each device gets its own account, and it never
leaves that device).

## How it works

Jazz's account secret is a 32-byte value (base64url). The WebAuthn **PRF** extension returns a
32-byte, credential-bound secret that is deterministic for a given `(credential, salt)`. So:

```
account secret = base64url( HKDF-SHA-256( PRF(passkey, fixed-salt) ) )
```

The same credential always derives the same account. No account material is stored on any server; it
is a pure function of the key.

### Boot flow (`device-passkey`, the default)

- **First boot on a device** → the runtime finds no cached secret and stays signed-out; the
  **AccountGate** island (`src/islands/AccountGate.tsx`) shows a sign-in card. A WebAuthn ceremony
  needs a user gesture, so this is a button, not an automatic prompt.
- **Sign in / create account** (a click) → derive the secret from the passkey → hand it to Jazz →
  cache it locally (`BrowserAuthSecretStore.saveSecret`) → recreate the runtime so data opens.
- **Return boots** → the cached secret is used; no ceremony. "Identity never waits" holds once you
  are signed in on a device.
- **A new device** → sign in with the same portable key → the same PRF → the same secret → the same
  Jazz account → your data syncs down and decrypts. Jazz already E2E-encrypts synced data keyed on
  the account, so nothing extra is needed for confidentiality.
- **Sign out** → forgets the cached secret on this device only (`clearSecret`); the passkey is
  untouched and signs back into the same account.

The framework side of this lives in `src/_lofi/session.ts` (`readSession`, `createPasskeyAccount`,
`signInWithPasskey`, `signOut`); the gate is the author-owned example you can restyle or replace.

## Portable vs device-bound — and telling the user which they chose

A passkey binds to its origin (RP ID) and roams (or doesn't) based on the credential provider, not
the OS. `enrollDeviceCredential` reports this via the WebAuthn **backup-eligible (BE)** flag:

- **Portable** (`portable: true`) — a password-manager or platform-synced passkey (1Password,
  iCloud, Google) or a hardware key you carry. **The account travels with it.** Favor these.
- **Device-bound** (`portable: false`) — Touch ID / Windows Hello without sync. **The account only
  exists on this device.** Allowed, but the app should say so: _use a portable passkey to reach this
  account elsewhere._

The nickname passed as `label` becomes the passkey's name in the user's password manager, so they
can see which account a key unlocks.

## Custody and recovery — stated plainly

- **No recovery service.** lofi never holds recoverable account material. Recovery is delegated to
  _where the key lives_: your password manager's own sync, or a second enrolled hardware key.
- **Lose every copy of the key → lose the account.** That is the honest cost of no-central-custody,
  and it is the same custody the device-local identity already has.
- **This is not the rejected passkey-_backup_ ceremony.** The Jazz alpha's server-assisted passkey
  account backup was rejected on security grounds. This model has no server-side account backup at
  all — the account is derived locally from the key — so it sidesteps that entirely.

## Guardrails (honest by construction)

- **Feature-detected.** `getAuthCapability()` reports `webAuthn` + `prf`; if PRF is unavailable,
  derivation throws `prf-unavailable` rather than fabricating a secret.
- **Origin-gated.** Enrollment and derivation refuse insecure origins (non-HTTPS, bare IPs) and any
  host an explicit `credentialOrigins` allowlist excludes — a passkey silently breaks if its origin
  changes. With no allowlist, the served origin is trusted so the app works wherever you deploy it
  (see [Origin trust](#origin-trust)).

## Origin trust

A passkey binds to its origin hostname (its RP ID) and silently breaks if that host changes. lofi
reads the current origin automatically; `credentialOrigins` is a separate promise that a host is
**permanent**:

```ts
// src/app.ts
credentialOrigins: [], // empty → trust the origin you are served from (works anywhere you deploy)
credentialOrigins: ["app.example.com", "*.example.com"], // pin permanent host(s) before shipping
```

Left empty, the served origin is trusted so the app works on any deployment, but a passkey enrolled
there dies if the host later changes (e.g. an ephemeral preview URL). Pin your permanent hostname(s)
once you have committed to them. Loopback (`localhost`) is trusted for local development but
reported as `local-only` because such credentials do not transfer between machines.

## Using the primitives directly

The default `device-passkey` wiring is done for you by `src/_lofi/session.ts` and the AccountGate
island. To drive it yourself:

```ts
import { deriveAccount, getAuthCapability } from "./_lofi/auth.ts";

const { prf, origin } = await getAuthCapability();
if (prf !== "unavailable" && origin.status !== "blocked") {
  // One user-gesture ceremony: derive the Jazz account secret and learn which key unlocked it.
  const { secret, credential } = await deriveAccount();
  // credential.portable === true → the account travels with this key
}
```
